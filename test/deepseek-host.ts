import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { DeepSeekHostClient, DeepSeekHostError } from '../src/main/deepseekHostClient.ts'
import { DeepSeekHostService } from '../src/main/deepseekHostService.ts'

const calls: any[] = []
let responseMode = 'ok'
const server = createServer(async (req, res) => {
  if (req.url === '/?token=test-secret') {
    res.writeHead(303, { 'Set-Cookie': 'dsh=auth-secret; HttpOnly', Location: '/' }); res.end(); return
  }
  assert.equal(req.headers.cookie, 'dsh=auth-secret')
  let data = ''; for await (const part of req) data += part
  const body = JSON.parse(data); calls.push(body)
  res.setHeader('Content-Type', 'application/json')
  if (responseMode === 'occupied') res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId,
    result: { ok: false, error: { code: 'session/writer-held', message: 'sensitive host details', details: { token: 'secret' } } } }))
  else if (responseMode === 'malformed') res.end(JSON.stringify({ type: 'server-response', rpcId: 'wrong', result: { ok: true } }))
  else if (responseMode === 'redirect') { res.writeHead(302, { Location: '/redirect-secret' }); res.end() }
  else if (responseMode === 'image-rejected') res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId,
    result: { ok: false, error: { code: 'session/attachment-invalid', message: 'secret-model-detail', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES', token: 'secret' } } } }))
  else res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items: [] } } }))
})
const ws = new WebSocketServer({ server, path: '/api/remote.mux' })
let cancelled = 0
ws.on('connection', (socket, request) => {
  assert.equal(request.headers.cookie, 'dsh=auth-secret')
  socket.on('message', data => {
    const request = JSON.parse(data.toString())
    if (request.type === 'cancel') { cancelled++; return }
    if (request.endpoint === 'session/bad') { socket.send('not-json'); return }
    if (request.endpoint === 'session/held') {
      socket.send(JSON.stringify({ type: 'error', streamId: request.streamId, error: { code: 'session/writer-held', message: 'secret', details: {} } })); return
    }
    socket.send(JSON.stringify({ type: 'item', streamId: request.streamId, value: { type: 'baseline', endpoint: request.endpoint } }))
    if (request.endpoint === 'session/finite') socket.send(JSON.stringify({ type: 'end', streamId: request.streamId }))
  })
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const address = server.address() as { port: number }
let client: DeepSeekHostClient | undefined
const root = await mkdtemp(join(tmpdir(), 'ua-host-test-'))
const hosts: DeepSeekHostService[] = []
try {
  for (const url of ['file:///tmp/a', 'http://example.com/?token=x', 'http://127.0.0.1:123/a?token=x', 'http://127.0.0.1:123/?token=x&next=bad']) {
    await assert.rejects(DeepSeekHostClient.connect(url), /invalid-launch-url/)
  }
  client = await DeepSeekHostClient.connect(`http://127.0.0.1:${address.port}/?token=test-secret`)
  assert.deepEqual(await client.call('session/list', { _request: {} }), { items: [] })
  assert.deepEqual(calls[0].payload, { args: { _request: {} } })
  assert.equal(calls[0].method, 'session/list')
  await assert.rejects(client.call('../escape'), /invalid-endpoint/)
  responseMode = 'occupied'
  const before = calls.length
  await assert.rejects(client.call('session/prompt', { request: { sessionId: 'same' } }), error => {
    assert(error instanceof DeepSeekHostError)
    assert.equal(error.code, 'session/writer-held')
    assert(!String(error).includes('sensitive'))
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls.length, before + 1, 'lock conflict is one rejected call, never a retry or queue')
  responseMode = 'malformed'; await assert.rejects(client.call('session/list'), /invalid-response/)
  responseMode = 'redirect'; await assert.rejects(client.call('session/list'), /transport-failed/)
  responseMode = 'image-rejected'
  await assert.rejects(client.call('session/prompt'), error => {
    assert(error instanceof DeepSeekHostError)
    assert.equal(error.code, 'session/attachment-invalid')
    assert.match(error.message, /模型不支持图片输入/)
    assert.doesNotMatch(error.message, /secret/)
    return true
  })
  responseMode = 'ok'
  const first = client.stream<any>('session/control')
  const second = client.stream<any>('session/finite')
  assert.equal((await first.next()).value.endpoint, 'session/control')
  assert.equal((await second.next()).value.endpoint, 'session/finite')
  assert.equal((await second.next()).done, true)
  await first.return(undefined)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(cancelled, 1, 'breaking the stream cancels its logical stream')
  await assert.rejects(client.stream('session/held').next(), /正在被其他应用使用/)
  const abort = new AbortController()
  const watching = client.stream('session/control', {}, abort.signal)
  await watching.next(); const pending = watching.next(); abort.abort()
  await assert.rejects(pending, /cancelled/)
  await assert.rejects(client.stream('session/bad').next(), /invalid-stream-frame/)
  client.close()
  await assert.rejects(client.call('session/list'), /closed/)
  assert(!JSON.stringify(client).includes('secret'), 'client serialization cannot expose authentication')

  const bin = join(root, 'dsh')
  await writeFile(bin, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${resolve('test/fixtures/fake-deepseek-host.cjs')}' "$@"\n`, { mode: 0o700 })
  const makeHost = (name: string, timeoutMs = 2_000) => {
    const host = new DeepSeekHostService({ bin, home: join(root, name), cwd: root, timeoutMs, patchFile: join(root, 'owned-patch.json') }); hosts.push(host); return host
  }
  const host = makeHost('healthy')
  const protectedHost = new DeepSeekHostService({ bin, home: join(root, 'secret-home'), cwd: root,
    modelEnvironment: { DEEPSEEK_API_KEY: 'explicit-secret' } })
  assert(!JSON.stringify(protectedHost).includes('explicit-secret'))
  const [a, b] = await Promise.all([host.start(), host.start()]); assert.equal(a, b, 'startup coalesces')
  const processInfo = JSON.parse(await readFile(join(root, 'healthy/fixture-process.json'), 'utf8'))
  assert.equal(processInfo.home, join(root, 'healthy'))
  assert.equal(processInfo.keyInherited, false)
  assert.equal(processInfo.nodeOptionsInherited, false)
  assert.deepEqual(processInfo.args, ['web', '--patch', join(root, 'owned-patch.json'), '--no-open', '--host', '127.0.0.1', '--port', '0'], 'profile precedes launcher overlays and app arguments')
  await host.stop(); await assert.rejects(a.call('session/list'), /closed/)
  assert.throws(() => process.kill(processInfo.pid, 0), /ESRCH/, 'owned child has been reaped')
  const restarted = await host.start(); assert.notEqual(restarted, a); await host.stop()
  await assert.rejects(makeHost('exit').start(), /startup-exited/)
  await assert.rejects(makeHost('timeout', 150).start(), /startup-timeout/)
  await assert.rejects(makeHost('bad-baseline').start(), /invalid-session-baseline/)
  const cancelledHost = makeHost('cancelled')
  const starting = cancelledHost.start(); const rejected = assert.rejects(starting, /start-cancelled|startup-exited/)
  await cancelledHost.stop(); await rejected
  console.log('DeepSeek Host: authentication, RPC correlation, streams, lock rejection and lifecycle passed')
} finally {
  client?.close()
  await Promise.all(hosts.map(host => host.stop()))
  for (const socket of ws.clients) socket.terminate()
  await new Promise<void>(resolve => ws.close(() => resolve()))
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
}
