import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireKimiWebService, closeKimiWebServices } from '../src/main/kimiWebService.ts'
import { KimiWebRuntime } from '../src/main/kimiWebRuntime.ts'
import { KimiWebServer } from '../src/main/kimiWebServer.ts'
import { KimiWebError } from '../src/main/kimiWebTransport.ts'
import { inspectACPProcess, sameProcessIdentity, signalACPProcess, type ProcessIdentity } from '../src/main/acp/acpProcessLifecycle.ts'

const root = await mkdtemp(join(tmpdir(), 'uniagent-kimi-recovery-'))
const fixture = resolve('test/fixtures/fake-kimi-web-service.cjs')
const children: ChildProcess[] = [], pids = new Map<number, ProcessIdentity>()
const read = async (home: string, name: string): Promise<any> => JSON.parse(await readFile(join(home, name), 'utf8'))
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const options = async (name: string) => {
  const home = join(root, name); await mkdir(home)
  await writeFile(join(home, 'session.json'), JSON.stringify({ marker: 'durable history', created: 0, prompts: 0 }))
  return { bin: process.execPath, argsPrefix: [fixture], cwd: root, env: { HOME: root, KIMI_CODE_HOME: home }, timeoutMs: 3000 }
}
const pidOf = async (lease: Awaited<ReturnType<typeof acquireKimiWebService>>): Promise<number> => {
  const { pid } = await lease.transport.request<any>('GET', '/api/v1/meta')
  const inspected = await inspectACPProcess(pid)
  assert.ok(inspected.ok && inspected.process); pids.set(pid, inspected.process)
  Object.defineProperty(lease.transport, 'timeoutMs', { value: 100 })
  return pid
}
try {
  const transient = await options('transient-shutdown')
  const transientHome = await realpath(transient.env.KIMI_CODE_HOME)
  const stalled = await acquireKimiWebService(transient), stalledPid = await pidOf(stalled)
  const capture = (KimiWebServer.prototype as any).captureProcesses
  let failInspection = true
  ;(KimiWebServer.prototype as any).captureProcesses = async function () {
    if (this.closed && this.options.env.KIMI_CODE_HOME === transientHome && failInspection) {
      failInspection = false
      throw new Error('transient process inspection failure')
    }
    return capture.call(this)
  }
  try {
    process.kill(stalledPid, 'SIGSTOP')
    await assert.rejects(stalled.transport.request('GET', '/api/v1/meta'), /shutdown_incomplete/)
    assert.ok(alive(stalledPid), 'failed inspection must not signal a process without verified ownership')
    assert.equal((await read(transient.env.KIMI_CODE_HOME, 'boots.json')).items.length, 1)
    const resumed = await Promise.all([acquireKimiWebService(transient), acquireKimiWebService(transient)])
    const resumedPid = await pidOf(resumed[0])
    assert.equal(alive(stalledPid), false, 'retry must revalidate and reap the original service before replacing it')
    assert.equal(await pidOf(resumed[1]), resumedPid, 'concurrent retries must share one replacement')
    assert.equal((await read(transient.env.KIMI_CODE_HOME, 'boots.json')).items.length, 2)
    assert.equal((await read(transient.env.KIMI_CODE_HOME, 'session.json')).marker, 'durable history')
    assert.equal((await read(transient.env.KIMI_CODE_HOME, 'session.json')).prompts, 0)
    process.kill(resumedPid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 50))
    await assert.rejects(resumed[0].transport.request('GET', '/api/v1/meta'), /connection/)
    const lastRetry = await acquireKimiWebService(transient), lastRetryPid = await pidOf(lastRetry)
    process.kill(lastRetryPid, 'SIGSTOP')
    await assert.rejects(lastRetry.transport.request('GET', '/api/v1/meta'), /recovery_limit/)
    assert.equal((await read(transient.env.KIMI_CODE_HOME, 'boots.json')).items.length, 3, 'rechecking a failed shutdown must not reset the restart budget')
    assert.equal(alive(lastRetryPid), false)
  } finally { (KimiWebServer.prototype as any).captureProcesses = capture }

  const a = await options('owned'), b = await options('unrelated')
  let lease = await acquireKimiWebService(a)
  const sibling = await acquireKimiWebService(b), siblingPid = await pidOf(sibling)
  let pid = await pidOf(lease)
  await writeFile(join(a.env.KIMI_CODE_HOME, 'control.json'), JSON.stringify({ stopAfterPrompt: true }))
  // The write is durably accepted before its response disappears. Recovery
  // must not replay it, even though the caller cannot know its outcome.
  await assert.rejects(lease.transport.request('POST', '/api/v1/sessions/native-session/prompts', { prompt_id: 'once', content: 'do once' }), /request_aborted/)
  assert.equal(alive(pid), false, 'confirmed unresponsive owned service must be stopped automatically')
  lease = await acquireKimiWebService(a)
  const replacement = await pidOf(lease)
  assert.notEqual(replacement, pid)
  assert.equal((await read(a.env.KIMI_CODE_HOME, 'session.json')).prompts, 1, 'uncertain POST must never be resent')
  assert.equal((await lease.transport.request<any>('GET', '/api/v1/sessions/native-session/snapshot')).session.marker, 'durable history')
  assert.ok(alive(siblingPid), 'recovery cannot stop another service instance')
  assert.equal((await sibling.transport.request<any>('GET', '/api/v1/meta')).pid, siblingPid)

  const count = (await read(a.env.KIMI_CODE_HOME, 'boots.json')).items.length
  await assert.rejects(lease.transport.request('GET', '/test/unauthorized'), /http: 401/)
  await assert.rejects(lease.transport.request('GET', '/test/slow'), /request_aborted/)
  assert.equal((await read(a.env.KIMI_CODE_HOME, 'boots.json')).items.length, count, 'auth or one slow endpoint with healthy meta must not restart the service')

  pid = replacement; process.kill(pid, 'SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 50))
  await Promise.all([0, 1].map(() => assert.rejects(lease.transport.request('GET', '/api/v1/meta'), /connection|request_aborted/)))
  lease = await acquireKimiWebService(a); pid = await pidOf(lease)
  assert.equal((await read(a.env.KIMI_CODE_HOME, 'boots.json')).items.length, 3, 'an exited owned service can be replaced within the same bounded budget')
  process.kill(pid, 'SIGSTOP')
  await assert.rejects(lease.transport.request('GET', '/api/v1/meta'), /recovery_limit/)
  await assert.rejects(acquireKimiWebService(a), /recovery_limit/)
  assert.equal((await read(a.env.KIMI_CODE_HOME, 'boots.json')).items.length, 3, 'automatic restarts must stop at two')
  assert.equal(alive(pid), false, 'exhausting restarts still reaps the confirmed owned hung service')

  const now = Date.now
  try {
    Date.now = () => now() + 5 * 60_000 + 1
    lease = await acquireKimiWebService(a)
    await pidOf(lease)
    assert.equal((await read(a.env.KIMI_CODE_HOME, 'boots.json')).items.length, 4, 'a later explicit check can start again after the cooldown')
  } finally { Date.now = now }

  const failed = await options('failed-restart')
  const failing = await acquireKimiWebService(failed), failedPid = await pidOf(failing)
  await writeFile(join(failed.env.KIMI_CODE_HOME, 'control.json'), JSON.stringify({ failStart: true }))
  process.kill(failedPid, 'SIGSTOP')
  await assert.rejects(failing.transport.request('GET', '/api/v1/meta'), /recovery_failed/)
  await assert.rejects(acquireKimiWebService(failed), /recovery_failed/)
  assert.equal((await read(failed.env.KIMI_CODE_HOME, 'boots.json')).items.length, 3, 'failed starts consume the same restart budget')
  assert.equal((await read(failed.env.KIMI_CODE_HOME, 'session.json')).marker, 'durable history')

  const unverified = await options('unverified-owner')
  const unverifiedHome = await realpath(unverified.env.KIMI_CODE_HOME)
  const guarded = await acquireKimiWebService(unverified), guardedPid = await pidOf(guarded)
  const close = KimiWebServer.prototype.closeAndWait
  KimiWebServer.prototype.closeAndWait = function () {
    if ((this as any).options.env.KIMI_CODE_HOME === unverifiedHome) {
      ;(this as any).identity = { ...(this as any).identity, startTime: 'Thu Jan 1 00:00:00 1970' }
    }
    return close.call(this)
  }
  try {
    process.kill(guardedPid, 'SIGSTOP')
    await assert.rejects(guarded.transport.request('GET', '/api/v1/meta'), /shutdown_incomplete/)
    await assert.rejects(acquireKimiWebService(unverified), /shutdown_incomplete/)
    assert.ok(alive(guardedPid), 'a changed process identity must never be signaled')
    assert.equal((await read(unverified.env.KIMI_CODE_HOME, 'boots.json')).items.length, 1, 'unconfirmed shutdown cannot start a second writer')
    process.kill(guardedPid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(alive(guardedPid), false)
    const cleared = await acquireKimiWebService(unverified)
    assert.notEqual(await pidOf(cleared), guardedPid, 'once the old group is confirmed gone, retry must not retain its failed close promise')
    assert.equal((await read(unverified.env.KIMI_CODE_HOME, 'boots.json')).items.length, 2)
    assert.equal((await read(unverified.env.KIMI_CODE_HOME, 'session.json')).marker, 'durable history')
  } finally { KimiWebServer.prototype.closeAndWait = close }

  const orphan = await options('owned-descendant')
  await writeFile(join(orphan.env.KIMI_CODE_HOME, 'control.json'), JSON.stringify({ spawnChild: true }))
  let parent = await acquireKimiWebService(orphan), parentPid = await pidOf(parent)
  const descendantPid = (await read(orphan.env.KIMI_CODE_HOME, 'child.json')).pid
  const descendant = await inspectACPProcess(descendantPid)
  assert.ok(descendant.ok && descendant.process); pids.set(descendantPid, descendant.process)
  process.kill(parentPid, 'SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(alive(descendantPid), 'fixture must leave a child behind when the service leader exits')
  await assert.rejects(parent.transport.request('GET', '/api/v1/meta'), /connection/)
  assert.equal(alive(descendantPid), false, 'owned descendants must be gone before the replacement is published')
  parent = await acquireKimiWebService(orphan); assert.notEqual(await pidOf(parent), parentPid)

  const unknownGroup = await options('unverified-descendant')
  await writeFile(join(unknownGroup.env.KIMI_CODE_HOME, 'control.json'), JSON.stringify({ spawnChild: true }))
  const unknownHome = await realpath(unknownGroup.env.KIMI_CODE_HOME)
  const unknown = await acquireKimiWebService(unknownGroup), unknownPid = await pidOf(unknown)
  const unknownChild = await inspectACPProcess((await read(unknownGroup.env.KIMI_CODE_HOME, 'child.json')).pid)
  assert.ok(unknownChild.ok && unknownChild.process); pids.set(unknownChild.process.pid, unknownChild.process)
  KimiWebServer.prototype.closeAndWait = function () {
    if ((this as any).options.env.KIMI_CODE_HOME === unknownHome) (this as any).processes = []
    return close.call(this)
  }
  try {
    process.kill(unknownPid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 50))
    await assert.rejects(unknown.transport.request('GET', '/api/v1/meta'), /shutdown_incomplete/)
    assert.ok(alive(unknownChild.process.pid), 'a group number without a surviving recorded identity cannot prove ownership')
    assert.equal((await read(unknownGroup.env.KIMI_CODE_HOME, 'boots.json')).items.length, 1, 'unverified descendants must block a second writer')
  } finally { KimiWebServer.prototype.closeAndWait = close }

  const borrowed = await options('borrowed')
  const child = spawn(process.execPath, [fixture], { cwd: root, env: { ...process.env, ...borrowed.env }, stdio: ['ignore', 'pipe', 'ignore'] }); children.push(child)
  await new Promise<void>((resolveReady, reject) => { child.stdout!.once('data', () => resolveReady()); child.once('error', reject) })
  const foreign = await acquireKimiWebService(borrowed), foreignPid = await pidOf(foreign)
  process.kill(foreignPid, 'SIGSTOP')
  await assert.rejects(foreign.transport.request('GET', '/api/v1/meta'), /request_aborted/)
  assert.ok(alive(foreignPid), 'a borrowed live instance is never signaled')
  assert.equal((await read(borrowed.env.KIMI_CODE_HOME, 'boots.json')).items.length, 1)
  process.kill(foreignPid, 'SIGCONT')
  await foreign.release()

  const session = await options('resume-session')
  const config = { agentId: 'kimi' as const, workdir: root, model: 'local', permissionMode: 'ask' as const }
  let runtime = await KimiWebRuntime.start({ ...session, sessionId: 'local', config, acquireWritableRuntime: async () => () => {} })
  const nativeId = runtime.nativeSessionId, active = await acquireKimiWebService(session), activePid = await pidOf(active)
  process.kill(activePid, 'SIGSTOP')
  await assert.rejects(runtime.snapshot(), /request_aborted/)
  await runtime.closeAndWait()
  runtime = await KimiWebRuntime.start({ ...session, sessionId: 'local', nativeSessionId: nativeId, config, acquireWritableRuntime: async () => () => {} })
  assert.equal(runtime.nativeSessionId, nativeId, 'recovery must resume the saved native session')
  assert.equal((await runtime.snapshot() as any).session.marker, 'durable history')
  assert.equal((await read(session.env.KIMI_CODE_HOME, 'session.json')).created, 1, 'resuming must not create a second session')
  assert.equal((await read(session.env.KIMI_CODE_HOME, 'session.json')).prompts, 0, 'resuming must not submit a task')
  await runtime.closeAndWait(); await active.release()

  const quitting = await options('quit-during-recovery')
  const last = await acquireKimiWebService(quitting), lastPid = await pidOf(last)
  let entered!: () => void, releaseHealth!: () => void
  const checking = new Promise<void>(resolve => { entered = resolve })
  const healthGate = new Promise<void>(resolve => { releaseHealth = resolve })
  last.transport.checkHealth = async () => { entered(); await healthGate; throw new KimiWebError('connection') }
  process.kill(lastPid, 'SIGSTOP')
  const pending = assert.rejects(last.transport.request('GET', '/api/v1/meta'), /request_aborted/)
  await checking
  const closing = closeKimiWebServices(); releaseHealth()
  await Promise.all([pending, closing])
  assert.equal((await read(quitting.env.KIMI_CODE_HOME, 'boots.json')).items.length, 1, 'shutdown must cancel recovery rather than resurrect a service')
  assert.equal(alive(lastPid), false)
  console.log('Kimi service recovery: confirmed faults, owned-only bounded restarts, failed recovery, no POST replay and durable session resume passed')
} finally {
  for (const identity of pids.values()) signalACPProcess(identity, await inspectACPProcess(identity.pid), 'SIGCONT')
  await closeKimiWebServices()
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  for (const identity of pids.values()) {
    signalACPProcess(identity, await inspectACPProcess(identity.pid), 'SIGKILL')
    for (let n = 0; n < 40; n++) {
      const inspected = await inspectACPProcess(identity.pid)
      if (inspected.ok && (!inspected.process || !sameProcessIdentity(inspected.process, identity))) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
}
