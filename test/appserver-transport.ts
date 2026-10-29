import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import {
  AppServerRpcClient,
  SharedAppServerRpc,
  type AppServerRpcClientOptions
} from '../src/main/appServerTransport.ts'

const fixture = resolve(process.cwd(), 'test/fixtures/fake-appserver.cjs')
const notifications: string[] = []
const client = new AppServerRpcClient({ bin: process.execPath, args: [fixture], cwd: process.cwd() })
const notificationSequences: number[] = []
client.on('notification', (method: string, _params: unknown, sequence?: number) => {
  notifications.push(method)
  if (sequence !== undefined) notificationSequences.push(sequence)
})

await client.start()
try {
  assert.deepEqual(await client.request('initialize', {}), { ok: true })
  assert.deepEqual(await client.request('echo', { value: 7 }), { value: 7 })
  assert.deepEqual(notifications, ['skills/changed'])
  assert.deepEqual(notificationSequences, [2])

  const nestedError = client.request('fail-with-nested-error', {})
  ;(client as any).onMessage({
    jsonrpc: '2.0',
    id: 3,
    error: { error: { message: 'unknown field beforeTurnId' } }
  })
  await assert.rejects(nestedError, /unknown field beforeTurnId/)

  const reasonError = client.request('fail-with-reason', {})
  ;(client as any).onMessage({ jsonrpc: '2.0', id: 4, error: { reason: 'transport rejection' } })
  await assert.rejects(reasonError, /transport rejection/)

  const unsupported = client.request('thread/items/list', {})
  ;(client as any).onMessage({
    jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'thread/items/list is not supported yet' }
  })
  await assert.rejects(unsupported, { code: -32601, message: 'thread/items/list is not supported yet' })

  const sequencedClient = new AppServerRpcClient({
    bin: process.execPath,
    args: [fixture],
    cwd: process.cwd()
  })
  ;(sequencedClient as any).child = { stdin: { write(): void {} } }
  const observed: Array<{ kind: string; sequence: number }> = []
  sequencedClient.on('notification', (_method, _params, sequence) => {
    observed.push({ kind: 'notification', sequence })
  })
  const response = (sequencedClient as any).requestSequenced('same-chunk', {}) as Promise<{
    result: unknown
    sequence: number
  }>
  response.then(({ sequence }) => observed.push({ kind: 'response-continuation', sequence }))
  ;(sequencedClient as any).onChunk(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { goal: null } })}\n` +
    `${JSON.stringify({ jsonrpc: '2.0', method: 'thread/goal/cleared', params: { threadId: 'thread-1' } })}\n`
  )
  await response
  await Promise.resolve()
  assert.deepEqual(observed, [
    { kind: 'notification', sequence: 2 },
    { kind: 'response-continuation', sequence: 1 }
  ])
} finally {
  await client.dispose()
}

class RecordingPhysicalTransport extends EventEmitter {
  calls: Array<{ method: string; params: any }> = []
  startCalls = 0
  disposeCalls = 0
  unsubscribeStatus?: string

  async start(): Promise<void> { this.startCalls += 1 }
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'initialize') return { ok: true } as T
    if (method === 'thread/fork') return { thread: { id: 'promoted-thread' } } as T
    if (method === 'thread/unsubscribe') return { status: this.unsubscribeStatus } as T
    return {} as T
  }
  notify(): void {}
  respond(): void {}
  interrupt(): void {}
  async dispose(): Promise<void> { this.disposeCalls += 1 }
}

{
  const physical = new RecordingPhysicalTransport()
  let factoryCalls = 0
  const shared = new SharedAppServerRpc((_options: AppServerRpcClientOptions) => {
    factoryCalls += 1
    return physical as any
  })
  const options = { bin: 'codex', args: ['app-server'], cwd: '/repo' }
  const main = shared.acquire(options)
  const side = shared.acquire()
  const promoted = shared.acquire()
  const mainNotifications: string[] = []
  const sideNotifications: string[] = []
  const promotedNotifications: string[] = []
  main.on('notification', (method) => mainNotifications.push(method))
  side.on('notification', (method) => sideNotifications.push(method))
  promoted.on('notification', (method) => promotedNotifications.push(method))

  await Promise.all([main.start(), side.start(), promoted.start()])
  await Promise.all([
    main.request('initialize', {}),
    side.request('initialize', {}),
    promoted.request('initialize', {})
  ])
  assert.equal(factoryCalls, 1, 'logical thread clients must share one physical app-server')
  assert.equal(physical.startCalls, 1)
  assert.equal(physical.calls.filter(({ method }) => method === 'initialize').length, 1)

  main.claimThread?.('main-thread')
  side.claimThread?.('side-thread')
  physical.emit('notification', 'main/event', { threadId: 'main-thread' }, 1)
  physical.emit('notification', 'side/event', { threadId: 'side-thread' }, 2)
  physical.emit('notification', 'global/event', {}, 3)
  assert.deepEqual(mainNotifications, ['main/event', 'global/event'])
  assert.deepEqual(sideNotifications, ['side/event', 'global/event'])
  assert.deepEqual(promotedNotifications, ['global/event'])

  await side.request('thread/fork', { threadId: 'side-thread', ephemeral: false })
  promoted.claimThread?.('promoted-thread')
  physical.emit('notification', 'promoted/event', { threadId: 'promoted-thread' }, 4)
  assert.deepEqual(promotedNotifications, ['global/event', 'promoted/event'])

  await side.dispose()
  assert.equal(physical.disposeCalls, 0, 'releasing one logical thread must keep the shared process alive')
  assert.deepEqual(
    physical.calls.filter(({ method }) => method === 'thread/unsubscribe').map(({ params }) => params.threadId),
    ['side-thread'],
    'only threads still owned by the released client may be unsubscribed'
  )
  physical.emit('notification', 'promoted/after-side-close', { threadId: 'promoted-thread' }, 5)
  assert.equal(promotedNotifications.at(-1), 'promoted/after-side-close')

  await promoted.dispose()
  assert.equal(physical.disposeCalls, 0)
  await main.dispose()
  assert.equal(physical.disposeCalls, 1, 'the final logical owner closes the physical app-server')
}

{
  const physical = new RecordingPhysicalTransport()
  physical.unsubscribeStatus = 'unsubscribed'
  const shared = new SharedAppServerRpc(() => physical as any)
  const main = shared.acquire({ bin: 'codex', args: ['app-server'], cwd: '/repo' })
  const side = shared.acquire()
  await main.start()
  main.claimThread?.('main-thread')
  side.claimThread?.('side-thread')
  let released = false
  const retiring = main.dispose(true).then(() => { released = true })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(released, false, '取消订阅响应不等于线程写锁已经释放')
  physical.emit('notification', 'thread/closed', { threadId: 'side-thread' })
  await Promise.resolve()
  assert.equal(released, false, '其它线程卸载不能解除当前线程的恢复屏障')
  physical.emit('notification', 'thread/closed', { threadId: 'main-thread' })
  await retiring
  assert.equal(released, true)
  assert.equal(physical.disposeCalls, 0, '侧边会话使用的物理进程仍然存活')
  await side.dispose()
  assert.equal(physical.disposeCalls, 1)
}

console.log('appserver-transport: ok')
