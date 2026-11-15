import assert from 'node:assert/strict'
import { fork, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Session } from '../src/shared/types'
import { configureRequirementRuntime, requirementCaller, setRequirementsEnabled } from '../src/main/requirementRuntime'

const foreign = process.argv[2] === 'foreign'
const root = foreign ? process.env.UNIAGENT_USER_DATA! : await mkdtemp(join(tmpdir(), 'ua-requirement-inbox-'))
process.env.UNIAGENT_USER_DATA = root
const session = { id: 'caller', config: { agentId: 'codex', requirementId: 'fixture-requirement' } } as Session
setRequirementsEnabled(true)
configureRequirementRuntime(id => id === session.id ? session : undefined)
const handoff = await import('../src/main/handoff')
const env = Object.fromEntries(handoff.handoffMcpServers(session.id)[0].env.map(row => [row.name, row.value]))

if (foreign) {
  const stop = handoff.watchRequirementInbox(async req => {
    process.send?.({ handled: req.id })
    requirementCaller(req.sessionId, req.token)
    return { foreign: true }
  })
  process.send?.({ ready: true, inbox: env.UNIAGENT_REQUIREMENT_INBOX })
  process.on('message', () => { stop(); process.exit(0) })
} else {
  let other: ChildProcess | undefined, server: ChildProcess | undefined, stop: (() => void) | undefined
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let stalled = false, releaseStalled!: () => void
  const stalledGate = new Promise<void>(resolve => { releaseStalled = resolve })
  const rename = fs.renameSync
  const sleep = () => new Promise(resolve => setTimeout(resolve, 15))
  const wait = async (check: () => boolean | Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 240; i++) { if (await check()) return; await sleep() }
    throw new Error('requirement inbox fixture timed out')
  }
  const inbox = env.UNIAGENT_REQUIREMENT_INBOX, results = env.UNIAGENT_REQUIREMENT_RESULTS
  const messages: any[] = [], order: string[] = []
  const first = randomUUID(), second = randomUUID(), third = randomUUID()
  const put = async (id: string, token = env.UNIAGENT_REQUIREMENT_TOKEN): Promise<void> => {
    await mkdir(inbox, { recursive: true })
    await writeFile(join(inbox, id + '.json'), JSON.stringify({ id, sessionId: session.id, token, args: { action: 'check' } }), { mode: 0o600 })
  }
  const retained = async (id: string) => (await readdir(inbox)).some(name => name.startsWith(id))
  const result = async (id: string) => JSON.parse(await readFile(join(results, id + '.json'), 'utf8'))
  try {
    other = fork(fileURLToPath(import.meta.url), ['foreign'], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    other.on('message', message => messages.push(message))
    await wait(() => messages.some(row => row.ready))
    await put(first)
    for (let i = 0; i < 10; i++) await sleep()
    assert.ok(await retained(first), 'another App must leave the owner request queued')
    assert.ok(!messages.some(row => row.handled), 'another App cannot consume or reject the owner capability')
    assert.notEqual(messages.find(row => row.ready).inbox, inbox, 'App instances have independent request inboxes')

    stop = handoff.watchRequirementInbox(async req => {
      order.push(req.id)
      requirementCaller(req.sessionId, req.token)
      if (req.id === first) await gate
      if (stalled) await stalledGate
      return { requestId: req.id }
    })
    await wait(() => order.includes(first))
    await put(second, 'invalid-fixture')
    await wait(async () => (await readdir(inbox)).some(name => name.startsWith(second) && name.endsWith('.claimed')))
    await put(third)
    await wait(async () => (await readdir(inbox)).some(name => name.startsWith(third) && name.endsWith('.claimed')))
    assert.deepEqual(order, [first], 'concurrent requests wait for the active operation')
    for (const id of [first, second, third]) assert.ok(await retained(id), 'unacknowledged requests remain on disk')
    release()
    await wait(async () => { try { return (await result(third)).ok } catch { return false } })
    assert.deepEqual(order, [first, second, third], 'an authentication failure does not block the following request')
    assert.deepEqual(await result(first), { ok: true, value: { requestId: first } })
    const failure = await result(second)
    assert.equal(failure.ok, false)
    assert.equal(failure.details.code, 'requirement_token_mismatch')
    assert.match(failure.error, /凭证.*不匹配/)
    assert.ok(!JSON.stringify(failure).includes(env.UNIAGENT_REQUIREMENT_TOKEN))
    await wait(async () => !(await retained(third)))

    const clock = join(root, 'clock.cjs')
    await writeFile(clock, 'const now=Date.now;let elapsed=0;Date.now=()=>now()+elapsed;process.on("message",message=>{if(message==="advance-clock")elapsed=121000});')
    server = spawn(process.execPath, ['--require', clock, handoff.ensureHandoffServer()], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
    let buffer = '', sequence = 0
    const pending = new Map<number, (message: any) => void>()
    server.stdout!.on('data', chunk => {
      buffer += chunk.toString()
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
        pending.get(message.id)?.(message)
      }
    })
    const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('requirement MCP response timed out')) }, 4000)
      pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message) })
      server!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'requirement-queue-test', version: '1' } })
    configureRequirementRuntime(() => undefined)
    const response = await rpc('tools/call', { name: 'requirement_context', arguments: { action: 'check' } })
    assert.equal(response.result.isError, true)
    const diagnostic = JSON.parse(response.result.content[0].text)
    assert.equal(diagnostic.details.code, 'requirement_session_not_found')
    assert.match(diagnostic.error, /会话不存在/)
    assert.ok(diagnostic.details.hint)

    configureRequirementRuntime(id => id === session.id ? session : undefined)
    stalled = true
    const beforeTimeout = order.length
    const timeoutResponse = rpc('tools/call', { name: 'requirement_context', arguments: { action: 'check' } })
    await wait(() => order.length > beforeTimeout)
    server.send('advance-clock')
    const timeout = JSON.parse((await timeoutResponse).result.content[0].text)
    assert.equal(timeout.details.code, 'requirement_result_timeout')
    assert.equal(timeout.details.outcome, 'unknown')
    assert.match(timeout.details.hint, /原 operationId/)
    assert.ok(await retained(timeout.details.requestId), 'client timeout never removes an unacknowledged request')
    releaseStalled(); stalled = false
    await wait(async () => !(await retained(timeout.details.requestId)))

    const failedReceipt = randomUUID()
    fs.renameSync = (from, to) => {
      if (String(to) === join(results, failedReceipt + '.json')) throw Object.assign(new Error('fixture disk error'), { code: 'EIO' })
      rename(from, to)
    }
    syncBuiltinESMExports()
    await put(failedReceipt)
    const { diagnostics } = await import('../src/main/diagnostics')
    await wait(() => diagnostics.list().some(row => row.code === 'requirement_result_write_failed'))
    assert.ok(await retained(failedReceipt), 'receipt write failure retains the original input')
    fs.renameSync = rename; syncBuiltinESMExports()
    const afterFailure = randomUUID(); await put(afterFailure)
    await wait(async () => { try { return (await result(afterFailure)).ok } catch { return false } })
    assert.equal(order.filter(id => id === failedReceipt).length, 1, 'an unconfirmed write is never automatically executed twice')
    console.log('PASS requirement inbox: process ownership, persistent waiting, sequential execution, failure continuation and concrete MCP errors')
  } finally {
    release()
    releaseStalled()
    stop?.()
    fs.renameSync = rename; syncBuiltinESMExports()
    for (const child of [server, other]) if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGTERM'); await exited
    }
    configureRequirementRuntime(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}
