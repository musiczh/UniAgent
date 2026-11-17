import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import test from 'node:test'
import { captureFixtureCloseTrace, annotateFixtureFailure } from './regression/acp-close-diagnostic.mjs'
import { ACPConnection } from '../src/main/acp/acpConnection'
import { awaitACPStartup, closeACPConnections, flushACPProcessRecords, inspectACPProcess, prepareACPConnections, sameProcessIdentity, stopACPProcessGroup, type ProcessIdentity } from '../src/main/acp/acpProcessLifecycle'

const childCode = `process.on('SIGTERM',()=>{});require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const frame=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{protocolVersion:1,agentCapabilities:{}}})+String.fromCharCode(10))});setInterval(()=>{},1000)`
const descendantCode = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const frame=JSON.parse(line);setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{protocolVersion:1,agentCapabilities:{},childPid:child.pid}})+String.fromCharCode(10)),300)});setInterval(()=>{},1000)`
const fixture = process.argv[2] === 'acp-lifecycle-fixture'
const owned: ProcessIdentity[] = []
async function alive(identity: ProcessIdentity): Promise<boolean> {
  const inspected = await inspectACPProcess(identity.pid)
  assert.ok(inspected.ok)
  return !!inspected.process && sameProcessIdentity(identity, inspected.process)
}
async function cleanup(): Promise<void> {
  for (const identity of owned.splice(0)) if (await alive(identity)) { try { process.kill(identity.pid, 'SIGKILL') } catch {} }
}
function output(value: unknown): void { console.log('ACP_FIXTURE ' + JSON.stringify(value)) }

if (fixture) {
  const mode = process.argv[3], directory = process.argv[4]
  if (mode === 'first-paint') {
    let ready!: () => void
    const path = join(directory, 'after-first-paint')
    const preparing = prepareACPConnections(path, new Promise<void>(resolve => { ready = resolve }))
    const connection = new ACPConnection({ bin: process.execPath, args: ['-e', childCode], providerLabel: 'Fixture' })
    const opening = connection.initialize()
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.equal((connection as any).child, null)
      await assert.rejects(readdir(path), { code: 'ENOENT' })
      output({ deferred: true })
      ready(); await preparing; await opening
      const inspected = await inspectACPProcess((connection as any).child.pid)
      assert.ok(inspected.ok && inspected.process)
      output({ children: [inspected.process] })
    } finally { ready(); await opening.catch(() => {}); await closeACPConnections() }
  } else if (mode === 'early-quit') {
    let ready!: () => void
    const preparing = prepareACPConnections(directory, new Promise<void>(resolve => { ready = resolve }))
    await closeACPConnections()
    ready(); await preparing
    const connection = new ACPConnection({ bin: process.execPath, args: ['-e', childCode], providerLabel: 'Fixture' })
    try { await assert.rejects(connection.initialize(), /正在退出/) }
    finally { await connection.closeAndWait() }
    output({ blocked: true })
  } else if (mode === 'setup-retry') {
    await assert.rejects(prepareACPConnections(directory, Promise.reject(new Error('fixture setup failure'))), /fixture setup failure/)
    const connection = new ACPConnection({ bin: process.execPath, args: ['-e', childCode], providerLabel: 'Grok' })
    try { await connection.initialize(); output({ recovered: true }) }
    finally { await closeACPConnections() }
  } else if (mode === 'scoped-retry' || mode === 'legacy-retry') {
    const parent = await inspectACPProcess(process.ppid)
    assert.ok(parent.ok && parent.process)
    const owner = { ...parent.process, startTime: 'Mon Jan 1 00:00:00 2001' }
    const root: ProcessIdentity = { pid: process.pid, ppid: owner.pid, uid: owner.uid, pgid: process.pid, startTime: owner.startTime }
    const path = join(directory, `${owner.pid}-${root.pid}.json`)
    const record = { version: 1, owner, root, processes: [], ...(mode === 'scoped-retry' ? { provider: 'mcode' } : {}) }
    await writeFile(path, JSON.stringify(record))
    await assert.rejects(prepareACPConnections(directory), /进程归属无法确认/)
    const other = new ACPConnection({ bin: process.execPath, args: ['-e', childCode], providerLabel: 'Grok alias', recoveryScope: 'grok' })
    const affected = new ACPConnection({ bin: process.execPath, args: ['-e', childCode], providerLabel: 'MiniMax alias', recoveryScope: 'mcode' })
    const sibling = new ACPConnection({ bin: process.execPath, args: ['-e', childCode], providerLabel: 'mcode' })
    try {
      await assert.rejects(affected.initialize(), /本地进程恢复未完成/)
      if (mode === 'scoped-retry') {
        await other.initialize()
        await awaitACPStartup('kimi')
      } else {
        await assert.rejects(other.initialize(), /本地进程恢复未完成/, 'unattributed legacy records remain guarded')
      }
      await writeFile(path, JSON.stringify({ ...record, owner: parent.process }))
      await Promise.all([affected.initialize(), sibling.initialize()])
      if (mode === 'legacy-retry') await other.initialize()
      output({ recovered: true })
    } finally { await closeACPConnections() }
  } else {
    await prepareACPConnections(directory)
    const connections: ACPConnection[] = []
    for (let n = 0; n < (mode === 'normal' ? 3 : 1); n++) {
      const connection = new ACPConnection({ bin: process.execPath, args: ['-e', mode === 'crash-descendant' ? descendantCode : childCode], providerLabel: ['Session', 'Probe', 'Quota'][n] })
      const response = await connection.initialize() as any
      connections.push(connection)
      const inspected = await inspectACPProcess((connection as any).child.pid)
      assert.ok(inspected.ok && inspected.process)
      owned.push(inspected.process)
      if (response.childPid) {
        const descendant = await inspectACPProcess(response.childPid)
        assert.ok(descendant.ok && descendant.process)
        owned.push(descendant.process)
      }
    }
    await flushACPProcessRecords()
    output({ children: owned })
    if (mode.startsWith('crash')) process.exit(0)
    if (mode === 'hold') await new Promise<void>(resolve => process.stdin.once('data', () => resolve()))
    connections[0].close()
    await closeACPConnections()
    await assert.rejects(connections[0].initialize(), /正在退出/)
    output({ closed: true })
  }
  process.exit(0)
} else {
  const exec = promisify(execFile)
  const file = fileURLToPath(import.meta.url)
  test('failure diagnostics preserve the original assertion when sampling or logging fails', async () => {
    const failure = new assert.AssertionError({ message: 'owned descendant still alive', actual: true, expected: false, operator: 'strictEqual' })
    const trace = { snapshot: () => [] }
    for (const [snapshot, write, sample] of [
      [trace, () => {}, async () => ({ kind: 'same-identity', stat: 'S' })],
      [trace, () => {}, async () => { throw new Error('sampling failed') }],
      [{ snapshot: () => { throw new Error('trace failed') } }, () => {}, async () => ({ kind: 'absent' })],
      [trace, () => { throw new Error('logging failed') }, async () => ({ kind: 'absent' })]
    ] as const) {
      await assert.rejects(annotateFixtureFailure(failure, undefined, snapshot, write, sample), (error: unknown) => error === failure)
    }
  })
  function capture(stdout: string): any[] {
    const rows = stdout.split('\n').filter(line => line.startsWith('ACP_FIXTURE ')).map(line => JSON.parse(line.slice(12)))
    owned.push(...rows.flatMap(row => row.children || []))
    return rows
  }
  async function host(mode: string, directory: string): Promise<any[]> {
    try { return capture((await exec(process.execPath, [file, 'acp-lifecycle-fixture', mode, directory], { timeout: 10_000 })).stdout) }
    catch (error) { capture((error as { stdout?: string }).stdout || ''); throw error }
  }

  test('closeAndWait waits for inherited process cleanup after the transport leader exits', async () => {
    const connection = new ACPConnection({ bin: process.execPath, args: ['-e', descendantCode], providerLabel: 'Grok' })
    try {
      const response = await connection.initialize() as any
      const inspected = await inspectACPProcess(response.childPid)
      assert.ok(inspected.ok && inspected.process)
      owned.push(inspected.process)
      const trace = captureFixtureCloseTrace(connection)
      await connection.closeAndWait()
      trace.markReturned()
      try {
        assert.equal(await alive(inspected.process), false, 'completion must include the owned descendant, not only the leader close event')
      } catch (originalFailure) {
        await annotateFixtureFailure(originalFailure, inspected.process, trace)
      }
    } finally { connection.close('SIGKILL'); await cleanup() }
  })

  test('application shutdown drains sessions, probes and quota connections before host exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ua-acp-quit-'))
    try {
      const rows = await host('normal', directory)
      assert.equal(rows.at(-1).closed, true)
      for (const identity of rows[0].children) assert.equal(await alive(identity), false)
      assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.json')), [])
    } finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
  })

  test('closeAndWait accepts valid process snapshots that finish within the inspection timeout', async () => {
    const connection = new ACPConnection({ bin: process.execPath, args: ['-e', childCode], providerLabel: 'Grok' })
    try {
      await connection.initialize()
      const inspected = await inspectACPProcess((connection as any).child.pid)
      assert.ok(inspected.ok && inspected.process)
      owned.push(inspected.process)
      const refresh = (connection as any).refreshProcessTree.bind(connection)
      ;(connection as any).refreshProcessTree = async (owner: any, ...args: any[]) => {
        const sweeping = owner.sweepStartedAt !== undefined
        const scan = await refresh(owner, ...args)
        // Successful scans may take up to one second; retain real kernel identities.
        if (sweeping && scan.ok) await new Promise(resolve => setTimeout(resolve, 600))
        return scan
      }
      await connection.closeAndWait()
      assert.equal(await alive(inspected.process), false, 'slow successful inspection must still confirm the owned process exit')
    } finally { connection.close('SIGKILL'); await cleanup() }
  })

  test('PID inspection accepts a slow valid kernel identity and still rejects a timed out query', async () => {
    const expected = await inspectACPProcess(process.pid)
    assert.ok(expected.ok && expected.process)
    const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')
    const execute = childProcess.execFile
    let waitMs = 600
    childProcess.execFile = function (file: string, ...args: any[]) {
      if (file !== '/bin/ps' || !args[0]?.includes('-p')) return Reflect.apply(execute, childProcess, [file, ...args])
      const code = `setTimeout(() => { const value = require('node:child_process').execFileSync('/bin/ps', process.argv.slice(1), {encoding:'utf8'}); process.stdout.write(value) }, ${waitMs})`
      return Reflect.apply(execute, childProcess, [process.execPath, ['-e', code, '--', ...args[0]], ...args.slice(1)])
    } as typeof execFile
    syncBuiltinESMExports()
    try {
      const slow = await inspectACPProcess(process.pid)
      assert.ok(slow.ok && slow.process, 'a valid 600ms kernel query fits the process inspection budget')
      assert.deepEqual(slow.process, expected.process)
      waitMs = 2000
      const stalled = await inspectACPProcess(process.pid)
      assert.equal(stalled.ok, false, 'an unresponsive query must not establish process ownership')
      if (!stalled.ok) assert.equal((stalled.error as { killed?: boolean }).killed, true)
    } finally { childProcess.execFile = execute; syncBuiltinESMExports() }
  })

  for (const mode of ['transient', 'persistent', 'reused', 'denied'] as const) {
    test(`owned cleanup ${mode}: revalidates timeouts and preserves unverified processes`, async () => {
      const child = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' })
      const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()) })
      let identity: ProcessIdentity
      try {
        const inspected = await inspectACPProcess(child.pid!)
        assert.ok(inspected.ok && inspected.process)
        identity = inspected.process
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
        throw error
      }
      const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')
      const execute = childProcess.execFile, signal = process.kill
      let queries = 0, freshIdentity = false
      const signals: string[] = []
      const timeout = Object.assign(new Error('fixture inspection deadline'), { code: null, killed: true, signal: 'SIGTERM' })
      const denied = Object.assign(new Error('fixture inspection denied'), { code: 'EACCES', killed: false })
      childProcess.execFile = function (file: string, ...args: any[]) {
        if (file !== '/bin/ps' || !args[0]?.includes('-p') || !args[0]?.includes(String(child.pid))) return Reflect.apply(execute, childProcess, [file, ...args])
        queries++
        const callback = args.pop()
        if (mode === 'denied' || mode === 'persistent' || queries === 1) {
          return Reflect.apply(execute, childProcess, [process.execPath, ['-e', ''], args[1], () => callback(mode === 'denied' ? denied : timeout, '', '')])
        }
        return Reflect.apply(execute, childProcess, [file, ...args, (error: unknown, stdout: string, stderr: string) => {
          if (mode === 'reused') stdout = `${identity.pid} ${identity.ppid} ${identity.uid} ${identity.pgid} Mon Jan 1 00:00:00 2001\n`
          else if (!error && stdout.trim().split(/\s+/)[0] === String(identity.pid)) freshIdentity = true
          callback(error, stdout, stderr)
        }])
      } as typeof execFile
      process.kill = function (pid, value) {
        if (Math.abs(pid) === identity.pid && value !== 0) {
          assert.equal(freshIdentity, true, 'no signal is allowed before a fresh successful kernel identity')
          signals.push(String(value))
        }
        return Reflect.apply(signal, process, [pid, value])
      } as typeof process.kill
      syncBuiltinESMExports()
      try {
        if (mode === 'persistent' || mode === 'denied') {
          await assert.rejects(stopACPProcessGroup(identity, [identity]), (error: unknown) => error instanceof Error &&
            error.message.includes(mode === 'persistent' ? 'TIMEOUT' : 'EACCES') && error.cause === (mode === 'persistent' ? timeout : denied))
          assert.equal(queries, mode === 'persistent' ? 2 : 1, 'only one transient timeout retry is permitted')
          assert.deepEqual(signals, [])
          assert.equal(process.kill(identity.pid, 0), true, 'failed inspection leaves the actual process alive')
        } else {
          await stopACPProcessGroup(identity, [identity])
          if (mode === 'transient') { assert.ok(freshIdentity); assert.ok(signals.includes('SIGTERM')); await exited }
          else {
            assert.ok(queries >= 2); assert.deepEqual(signals, [], 'a changed start identity is never signalled')
            assert.equal(process.kill(identity.pid, 0), true, 'the process with a reused identity is preserved')
          }
        }
      } finally {
        childProcess.execFile = execute; process.kill = signal; syncBuiltinESMExports()
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
      }
      assert.equal((await inspectACPProcess(identity.pid)).ok, true)
    })
  }

  test('startup closes abandoned ACP processes before opening a usable replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ua-acp-recover-'))
    try {
      const [previous] = await host('crash', directory)
      assert.equal(await alive(previous.children[0]), true)
      const [name] = (await readdir(directory)).filter(file => file.endsWith('.json'))
      assert.equal(JSON.parse(await readFile(join(directory, name), 'utf8')).provider, 'session', 'new records carry their provider scope')
      const next = await host('recover', directory)
      assert.equal(next.at(-1).closed, true)
      assert.equal(await alive(previous.children[0]), false)
      assert.notEqual(previous.children[0].pid, next[0].children[0].pid)
    } finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
  })

  test('startup discovers a late descendant before its abandoned leader exits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ua-acp-late-descendant-'))
    try {
      const [previous] = await host('crash-descendant', directory)
      const [name] = (await readdir(directory)).filter(name => name.endsWith('.json'))
      const file = join(directory, name)
      const record = JSON.parse(await readFile(file, 'utf8'))
      record.processes = [record.root]
      await writeFile(file, JSON.stringify(record))
      await host('recover', directory)
      for (const identity of previous.children) assert.equal(await alive(identity), false)
    } finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
  })

  test('startup preserves connections belonging to another live UniAgent instance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ua-acp-live-owner-'))
    const child = spawn(process.execPath, [file, 'acp-lifecycle-fixture', 'hold', directory], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    const ready = new Promise<any>((resolve, reject) => {
      child.stdout.on('data', chunk => {
        stdout += chunk.toString()
        const line = stdout.split('\n').find(line => line.startsWith('ACP_FIXTURE '))
        if (line) resolve(capture(line)[0])
      })
      child.once('error', reject)
    })
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    try {
      const previous = await ready
      await host('recover', directory)
      assert.equal(await alive(previous.children[0]), true)
      child.stdin.end('quit')
      await exited
      assert.equal(await alive(previous.children[0]), false)
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await cleanup(); await rm(directory, { recursive: true, force: true }) }
  })

  test('startup does not signal a reused PID with a different start identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ua-acp-reused-pid-'))
    try {
      const [previous] = await host('crash', directory)
      const [name] = (await readdir(directory)).filter(name => name.endsWith('.json'))
      const record = JSON.parse(await readFile(join(directory, name), 'utf8'))
      record.root.startTime = 'Mon Jan 1 00:00:00 2001'
      for (const identity of record.processes) identity.startTime = record.root.startTime
      await writeFile(join(directory, name), JSON.stringify(record))
      await host('recover', directory)
      assert.equal(await alive(previous.children[0]), true, 'a mismatched identity must never be terminated')
    } finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
  })

  test('quit before first paint neither waits forever nor permits a late ACP spawn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ua-acp-early-quit-'))
    try { assert.equal((await host('early-quit', directory))[0].blocked, true) }
    finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
  })

  test('startup defers recovery I/O and ACP spawning until the first UI document is ready', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ua-acp-first-paint-'))
    try { assert.equal((await host('first-paint', directory))[0].deferred, true) }
    finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
  })

  test('invalid recovery records stop recovery without signaling an unrelated process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ua-acp-invalid-record-'))
    try {
      const [previous] = await host('crash', directory)
      const [name] = (await readdir(directory)).filter(name => name.endsWith('.json'))
      const file = join(directory, name)
      const record = JSON.parse(await readFile(file, 'utf8'))
      record.processes.push(record.owner)
      await writeFile(file, JSON.stringify(record))
      await assert.rejects(host('recover', directory), /归属记录无效/)
      assert.equal(await alive(previous.children[0]), true)
      await writeFile(file, '{invalid-json')
      await assert.rejects(host('recover', directory), /归属记录无法读取/)
      assert.equal(await alive(previous.children[0]), true)
    } finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
  })

  for (const mode of ['scoped-retry', 'legacy-retry']) {
    test(`${mode}: recovery retries safely without poisoning future detection`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'ua-acp-retry-'))
      try { assert.equal((await host(mode, directory))[0].recovered, true) }
      finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
    })
  }

  test('a failed startup setup is retried by the next connection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ua-acp-setup-retry-'))
    try { assert.equal((await host('setup-retry', directory))[0].recovered, true) }
    finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
  })
}
