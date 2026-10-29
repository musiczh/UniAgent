import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DeepSeekHostService } from '../src/main/deepseekHostService.ts'

// Explicit local runtime; no account credentials, user session root or model request.
const runtime = process.env.UNIAGENT_DEEPSEEK_TEST_RUNTIME
if (!runtime) throw new Error('Set UNIAGENT_DEEPSEEK_TEST_RUNTIME to the installed runtime directory')
const root = await mkdtemp(join(tmpdir(), 'uniagent-host-native-'))
const host = new DeepSeekHostService({ bin: join(runtime, 'node_modules/.bin/dsh'), home: join(root, 'home'), cwd: root })
const children = new Set<ChildProcess>()
const launch = (store: string, mode: string) => {
  const child = spawn(process.execPath, [resolve('test/fixtures/deepseek-lock-worker.mjs'), runtime, store, mode], {
    env: { PATH: process.env.PATH, HOME: root, DSH_HOME: join(root, 'home') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  children.add(child)
  const output: string[] = []
  const errors: string[] = []
  child.stdout!.on('data', data => output.push(String(data)))
  child.stderr!.on('data', data => errors.push(String(data)))
  const exited = once(child, 'exit').then(([code]) => { children.delete(child); return code })
  return { child, output, errors, exited }
}
const check = async (store: string, mode: string) => {
  const process = launch(store, mode)
  assert.equal(await process.exited, 0, `native ${mode} worker failed: ${process.errors.join('')}`)
  return JSON.parse(process.output.join(''))
}
const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); void host.stop() }, 45_000)
try {
  const client = await host.start()
  const catalog = await client.call<{ groups: unknown[] }>('session/modelCatalog')
  assert(Array.isArray(catalog.groups))
  const stream = client.stream<any>('session/control', {}, AbortSignal.timeout(5000))
  assert.equal((await stream.next()).value.type, 'baseline')
  await stream.return(undefined)
  console.log('PASS real Host startup, cookie authentication, session/list, modelCatalog, control stream')
  for (const exitMode of ['release', 'crash']) {
    const store = join(root, exitMode)
    const holder = launch(store, 'hold')
    await Promise.race([
      (async () => { while (!holder.output.join('').includes('holding\n')) await once(holder.child.stdout!, 'data') })(),
      holder.exited.then(() => { throw new Error('holder exited before acquiring write ownership: ' + holder.errors.join('')) })
    ])
    assert.deepEqual(await check(store, 'write'), { status: 'occupied' })
    assert.deepEqual(await check(store, 'read'), { status: 'opened', count: 2 })
    if (exitMode === 'release') holder.child.send('release')
    else holder.child.kill('SIGKILL')
    await holder.exited
    assert.deepEqual(await check(store, 'write'), { status: 'opened', count: 2 })
    console.log(`PASS real native lock: contention rejects, read allowed, ${exitMode} releases ownership`)
  }
} finally {
  clearTimeout(timer)
  await host.stop()
  for (const child of children) child.kill('SIGKILL')
  await Promise.all([...children].map(child => once(child, 'exit')))
  await rm(root, { recursive: true, force: true })
}
