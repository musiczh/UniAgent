import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { WSClient } from '@larksuiteoapi/node-sdk'

// Exercise the installed SDK, not a bridge stub. These are the asynchronous
// boundaries in node-sdk/ws-client/index.ts at which close() must cancel work.
const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const tick = () => new Promise(setImmediate)
function fixture(t) {
  const events = []
  const client = new WSClient({
    appId: 'cli_0000000000000000', appSecret: 'test-only',
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    onReady: () => events.push('ready'), onReconnected: () => events.push('reconnected'),
    onError: () => events.push('error'), handshakeTimeoutMs: 1000
  })
  client.communicate = () => events.push('communicate')
  client.pingLoop = () => {}
  t.after(() => client.close({ force: true }))
  return { client, events }
}

test('a normal handshake and reconnect still become ready', { timeout: 3000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close() })
  const { client, events } = fixture(t)
  client.wsConfig.updateWs({ connectUrl: `ws://127.0.0.1:${server.address().port}`, reconnectNonce: 0 })
  client.pullConnectConfig = async () => ({ ok: true })
  await client.reConnect(true)
  assert.deepEqual(events, ['communicate', 'ready'])
  assert.equal(client.getConnectionStatus().state, 'connected')
  const reconnected = deferred()
  client.onReconnected = () => { events.push('reconnected'); reconnected.resolve() }
  await client.reConnect()
  await reconnected.promise
  assert.deepEqual(events, ['communicate', 'ready', 'communicate', 'reconnected'])
  assert.equal(client.getConnectionStatus().state, 'connected')
  client.close({ force: true })
  assert.equal(client.getConnectionStatus().state, 'idle')
})

test('close during endpoint discovery prevents the first connection and retries', async t => {
  const { client, events } = fixture(t)
  const discovery = deferred()
  client.pullConnectConfig = () => discovery.promise
  client.connect = async () => { events.push('connect'); return true }
  const starting = client.reConnect(true)
  client.close({ force: true })
  discovery.resolve({ ok: true })
  await starting
  await tick()
  assert.deepEqual(events, [])
  assert.equal(client.getConnectionStatus().state, 'idle')
})

test('late handshake completion after close cannot start communication or stay connected', async t => {
  const { client, events } = fixture(t)
  const handshake = deferred()
  const entered = deferred()
  const socket = new EventEmitter()
  socket.readyState = 1
  socket.terminate = () => { socket.readyState = 3 }
  client.pullConnectConfig = async () => ({ ok: true })
  client.connect = async () => {
    client.wsConfig.setWSInstance(socket)
    entered.resolve()
    await handshake.promise
    return true
  }
  const starting = client.reConnect(true)
  await entered.promise
  client.close({ force: true })
  handshake.resolve()
  await starting
  assert.deepEqual(events, [])
  assert.equal(socket.readyState, 3)
  assert.equal(client.getConnectionStatus().state, 'idle')
})

for (const reconnect of [false, true]) {
  test(`close cancels an actual pending ${reconnect ? 'reconnect' : 'initial'} WebSocket handshake`, { timeout: 3000 }, async t => {
    const server = createServer()
    const upgraded = deferred(), disconnected = deferred()
    let peer
    server.on('upgrade', (_request, socket) => {
      peer = socket
      socket.on('close', disconnected.resolve)
      socket.on('end', () => socket.end())
      socket.resume()
      upgraded.resolve()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => { peer?.destroy(); server.close() })
    const { client, events } = fixture(t)
    client.hasEverConnected = reconnect
    client.wsConfig.updateWs({ connectUrl: `ws://127.0.0.1:${server.address().port}`, reconnectNonce: 0 })
    client.pullConnectConfig = async () => ({ ok: true })
    const starting = client.reConnect(!reconnect)
    await upgraded.promise
    client.close({ force: true })
    await Promise.race([
      disconnected.promise,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('pending socket survived close()')), 400)
        t.after(() => clearTimeout(timer))
      })
    ])
    await starting
    await tick()
    assert.deepEqual(events, [])
    assert.equal(client.getConnectionStatus().state, 'idle')
  })
}
