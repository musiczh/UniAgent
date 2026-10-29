import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireKimiWebService, closeKimiWebServices } from '../src/main/kimiWebService.ts'
import { KimiWebError } from '../src/main/kimiWebTransport.ts'

// Regression: discovery must reuse a live kimi web service even though kimi
// rewrites its process title to "kimi-code" (ps can never show the executable
// path), and must skip stale instance registrations instead of failing.

const roots: string[] = []
const children: ChildProcess[] = []
const fixtureHome = (): { root: string; home: string } => {
  const root = mkdtempSync(join(tmpdir(), 'uniagent-kimi-web-lifecycle-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(join(home, 'server', 'instances'), { recursive: true, mode: 0o700 })
  return { root, home }
}
const binPath = (root: string, script: string): string => {
  const file = join(root, 'bin')
  writeFileSync(file, script, { mode: 0o700 })
  return file
}
const waitReady = (child: ChildProcess, timeoutMs = 5000): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('fixture did not start')), timeoutMs)
  child.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('ready')) { clearTimeout(timer); resolve() } })
  child.once('exit', code => { clearTimeout(timer); reject(new Error('fixture exited early: ' + code)) })
})
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const waitDead = async (pid: number, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (!alive(pid)) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error('process ' + pid + ' still alive')
}
const expectError = async (flight: Promise<unknown>): Promise<string> => {
  try { await flight; assert.fail('expected rejection') } catch (error) { return error instanceof KimiWebError ? error.message : String(error) }
}

// A kimi web service that behaves like the official CLI: it rewrites its
// process title, registers itself under server/instances and only answers
// authenticated loopback requests. `banner` selects the ready signal style.
const fixtureSource = (banner: 'ready' | 'banner'): string => `
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
process.title = 'kimi-code';
const home = process.env.KIMI_CODE_HOME, serverId = 'fixture-' + process.pid;
let stalled = false;
process.on('message', value => { stalled = value === 'stall'; process.send('ack'); });
fs.writeFileSync(path.join(home, 'server.token'), 'fixture-secret', { mode: 0o600 });
const paths = {'/api/v1/sessions/{session_id}/goal':{get:{}},'/api/v1/sessions/{session_id}/profile':{post:{}},'/api/v1/sessions/{session_id}/prompts':{post:{}},'/api/v1/sessions/{session_id}/prompts/{tail}':{post:{}}};
const server = http.createServer((req, res) => {
  if (stalled) return;
  if (req.headers.authorization !== 'Bearer fixture-secret') { res.writeHead(401); return res.end(JSON.stringify({ code: 40101, data: null })); }
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/v1/meta') res.end(JSON.stringify({ code: 0, data: { server_version: '2.2.0', server_id: serverId + '-meta', backend: 'v2', dangerous_bypass_auth: false } }));
  else if (req.url === '/openapi.json') res.end(JSON.stringify({ paths }));
  else if (req.url === '/asyncapi.json') res.end(JSON.stringify({ asyncapi: '3.0.0' }));
  else res.end(JSON.stringify({ code: 0, data: {} }));
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(home, 'server', 'instances', serverId + '.json'), JSON.stringify({ server_id: serverId, pid: process.pid, host: '127.0.0.1', port: server.address().port, started_at: Date.now(), heartbeat_at: Date.now(), host_version: '2.2.0' }));
  process.stdout.write(${banner === 'banner' ? `'Kimi server: http://127.0.0.1:' + server.address().port + '#fixture\\n'` : `'ready\\n'`});
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`
const startFixture = async (home: string, banner: 'ready' | 'banner'): Promise<{ pid: number; child: ChildProcess }> => {
  const fixture = join(home, '..', `fixture-${banner}.cjs`)
  writeFileSync(fixture, fixtureSource(banner), { mode: 0o700 })
  const child = spawn(process.execPath, [fixture], { env: { ...process.env, KIMI_CODE_HOME: home }, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] })
  children.push(child)
  await waitReady(child)
  return { pid: child.pid!, child }
}

const versionBin = (root: string): string => binPath(root, '#!/bin/sh\necho not-a-version\n')

try {
  // 1. Live service with rewritten process title must be reused, not rejected.
  {
    const { root, home } = fixtureHome()
    const { pid } = await startFixture(home, 'ready')
    try {
      const lease = await acquireKimiWebService({ bin: versionBin(root), cwd: root, env: { KIMI_CODE_HOME: home }, timeoutMs: 5000 })
      assert.equal(lease.version, '2.2.0', 'borrowed service must be reused')
      await lease.release()
      assert.ok(alive(pid), 'release must never stop a borrowed service')
    } finally { process.kill(pid, 'SIGTERM') }
    console.log('reused title-rewritten live service instead of server_source_unverified')
  }

  // A registered service can be alive while its HTTP handlers stop responding.
  // Detection must time out without spawning another writer or losing retries.
  {
    const { root, home } = fixtureHome()
    const { pid, child } = await startFixture(home, 'ready')
    const setState = (state: string): Promise<void> => new Promise(resolve => {
      child.once('message', () => resolve()); child.send(state)
    })
    try {
      await setState('stall')
      const started = Date.now()
      const message = await expectError(acquireKimiWebService({ bin: versionBin(root), cwd: root, env: { KIMI_CODE_HOME: home }, timeoutMs: 200 }))
      assert.equal(message, 'kimi_web_request_aborted', 'an unresponsive service is a timeout, not missing CLI or authentication')
      assert.ok(Date.now() - started < 3000, 'detection must settle after its request deadline')
      assert.ok(alive(pid), 'failed detection must leave the existing service untouched')
      await setState('resume')
      const lease = await acquireKimiWebService({ bin: join(root, 'bin'), cwd: root, env: { KIMI_CODE_HOME: home }, timeoutMs: 1000 })
      assert.equal(lease.version, '2.2.0', 'a timed-out discovery must not poison the next detection')
      await lease.release()
    } finally { child.kill('SIGTERM') }
    console.log('timed out an unresponsive service, preserved its process and retried successfully')
  }

  // 2. A registration whose pid is gone is stale: fall through to a normal start.
  {
    const { root, home } = fixtureHome()
    writeFileSync(join(home, 'server', 'instances', 'stale.json'), JSON.stringify({ server_id: 'stale', pid: 2147483646, host: '127.0.0.1', port: 1, started_at: Date.now(), heartbeat_at: Date.now(), host_version: '2.2.0' }))
    const message = await expectError(acquireKimiWebService({ bin: versionBin(root), cwd: root, env: { KIMI_CODE_HOME: home }, timeoutMs: 5000 }))
    assert.equal(message, 'kimi_web_version_unsupported', 'dead-pid registration must be skipped, not fail identity checks')
  }

  // 3. A recycled pid that does not listen on the recorded port is also stale.
  {
    const { root, home } = fixtureHome()
    const bystander = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    children.push(bystander)
    try {
      writeFileSync(join(home, 'server', 'instances', 'recycled.json'), JSON.stringify({ server_id: 'recycled', pid: bystander.pid, host: '127.0.0.1', port: 9, started_at: Date.now(), heartbeat_at: Date.now(), host_version: '2.2.0' }))
      const message = await expectError(acquireKimiWebService({ bin: versionBin(root), cwd: root, env: { KIMI_CODE_HOME: home }, timeoutMs: 5000 }))
      assert.equal(message, 'kimi_web_version_unsupported', 'non-listening pid must be treated as stale registration')
    } finally { bystander.kill('SIGTERM') }
    console.log('skipped stale registrations (dead pid and recycled pid)')
  }

  // 4. Quitting UniAgent must kill services it started (no orphan processes).
  {
    const { root, home } = fixtureHome()
    const fixture = join(home, '..', 'owned.cjs')
    writeFileSync(fixture, fixtureSource('banner'), { mode: 0o700 })
    const lease = await acquireKimiWebService({ bin: process.execPath, argsPrefix: [fixture], cwd: root, env: { KIMI_CODE_HOME: home }, timeoutMs: 5000 })
    // The owned child registered itself; read its pid from the instance file.
    const instances = join(home, 'server', 'instances')
    const rows = readdirSync(instances).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(instances, name), 'utf8')))
    const ownedPid = rows.find(row => typeof row.server_id === 'string')?.pid as number
    assert.ok(Number.isInteger(ownedPid) && ownedPid > 0, 'owned fixture must register its pid')
    try {
      await closeKimiWebServices()
      await waitDead(ownedPid)
      assert.equal(lease.version, '2.2.0', 'owned lease reports the service version')
      console.log('closeKimiWebServices killed the owned service process group')
    } finally {
      if (alive(ownedPid)) process.kill(ownedPid, 'SIGKILL')
    }
  }

  // 5. Quitting must never stop a service UniAgent did not start.
  {
    const { root, home } = fixtureHome()
    const { pid } = await startFixture(home, 'ready')
    try {
      await acquireKimiWebService({ bin: versionBin(root), cwd: root, env: { KIMI_CODE_HOME: home }, timeoutMs: 5000 })
      await closeKimiWebServices()
      assert.ok(alive(pid), 'borrowed service must survive closeKimiWebServices')
    } finally { process.kill(pid, 'SIGTERM') }
    console.log('closeKimiWebServices left the borrowed service running')
  }

  console.log('Kimi web service discovery: live reuse, stale registration and quit cleanup passed')
} finally {
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
