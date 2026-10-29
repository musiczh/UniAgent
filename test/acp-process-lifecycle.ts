import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { ACPConnection } from '../src/main/acp/acpConnection'
import { closeACPConnections, flushACPProcessRecords, inspectACPProcess, prepareACPConnections, sameProcessIdentity, type ProcessIdentity } from '../src/main/acp/acpProcessLifecycle'

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
      await connection.closeAndWait()
      assert.equal(await alive(inspected.process), false, 'completion must include the owned descendant, not only the leader close event')
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

  test('startup closes abandoned ACP processes before opening a usable replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ua-acp-recover-'))
    try {
      const [previous] = await host('crash', directory)
      assert.equal(await alive(previous.children[0]), true)
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
}
