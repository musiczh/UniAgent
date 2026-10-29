import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHostService } from '../src/main/deepseekHostService.ts'
import { deepseekAccountModels } from '../src/main/deepseekService.ts'
import { DeepSeekHostRunner } from '../src/main/deepseekHostRunner.ts'

// Actual published Host + synthetic local Platform. Never touches the user's account or opens a browser.
const runtime = process.env.UNIAGENT_DEEPSEEK_TEST_RUNTIME
if (!runtime) throw new Error('Set UNIAGENT_DEEPSEEK_TEST_RUNTIME to the installed runtime directory')
const root = await mkdtemp(join(tmpdir(), 'uniagent-account-native-'))
const home = join(root, 'home')
let initialization: any
let exchanges = 0
let modelRequests = 0
let platformOrigin = ''
const platform = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const input = body ? JSON.parse(body) : {}
  if (request.url === '/v1/messages') {
    assert.equal(request.headers['x-dsh-auth-token'], 'local-fixture-grant')
    assert.equal(request.headers['x-api-key'], undefined)
    modelRequests++
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of [
      { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'account route verified' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' }
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end(); return
  }
  let data: any = {}
  if (request.url?.endsWith('/auth_init')) {
    initialization = input
    data = { authorize_url: platformOrigin + '/dsh/authorize?id=fixture', authorize_id: 'fixture', expires_in: 60 }
  } else if (request.url?.endsWith('/auth_exchange')) {
    assert.equal(createHash('sha256').update(input.code_verifier).digest('base64url'), initialization.code_challenge)
    assert.equal(input.redirect_uri, initialization.redirect_uri)
    exchanges++
    data = { token: 'local-fixture-grant', authorized_url: platformOrigin + '/dsh/authorized' }
  }
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: data } }))
})
let host: DeepSeekHostService | undefined
let runner: DeepSeekHostRunner | undefined
try {
  platform.listen(0, '127.0.0.1'); await once(platform, 'listening')
  platformOrigin = `http://127.0.0.1:${(platform.address() as { port: number }).port}`
  await mkdir(home, { mode: 0o700 })
  await writeFile(join(home, 'cordis.patch.yml'), JSON.stringify([
    { id: 'deepseek-account', config: { platformOrigin, inferenceOrigin: platformOrigin, allowLoopbackHttp: true, attemptTimeoutMs: 15000 } },
    { id: 'llm-deepseek-account', config: { baseURL: platformOrigin } }
  ]), { mode: 0o600 })
  host = new DeepSeekHostService({ bin: join(runtime, 'node_modules/.bin/dsh'), home, cwd: root })
  const client = await host.start()
  const metadata = { version: '1.0.9', locale: 'zh-CN', timezoneOffsetSeconds: 28800 }
  assert.equal((await client.call<any>('account/getState')).status, 'signed-out')
  const stream = client.stream<any>('account/watch', {}, AbortSignal.timeout(20000))
  assert.equal((await stream.next()).value.status, 'signed-out')
  await client.call('account/startSignIn', { client: metadata, callbackOrigin: client.callbackOrigin, loginSource: 'desktop' })
  let state: any
  do { state = (await stream.next()).value } while (state.attempt?.phase === 'initializing')
  assert.equal(state.attempt?.phase, 'waiting-browser')
  assert.equal(state.status, 'signed-out', 'opening authorization is not login success')
  const bad = await fetch(initialization.redirect_uri + '?state=wrong&code=fixture', { redirect: 'manual' })
  assert.equal(bad.status, 400); await bad.body?.cancel()
  assert.equal(exchanges, 0, 'invalid state cannot exchange a code')
  const callback = fetch(initialization.redirect_uri + '?state=' + encodeURIComponent(initialization.state) + '&code=fixture', { redirect: 'manual' })
  do { state = (await stream.next()).value } while (state.attempt?.phase !== 'succeeded' && state.attempt?.phase !== 'failed')
  assert.equal(state.attempt.phase, 'succeeded')
  assert.equal(state.status, 'credential-stored')
  const response = await callback
  assert.equal(response.status, 302); await response.body?.cancel()
  assert.equal(exchanges, 1)
  await stream.return(undefined)
  const accountModels = deepseekAccountModels(await client.call('session/modelCatalog'))
  assert.ok(accountModels.length > 0)
  runner = new DeepSeekHostRunner('account-qualification', { n: 0 }, {
    id: 'deepseek', name: 'DeepSeek Harness', adapter: 'deepseek', bin: join(runtime, 'node_modules/.bin/dsh'), icon: 'deepseek', builtin: true,
    models: accountModels, capabilities: { protocol: 'acp', modelSelect: true, reasoningEffort: true, permissionModes: [] }
  }, { agentId: 'deepseek', workdir: root, permissionMode: 'ask', model: accountModels[0].id }, undefined,
  undefined, async () => client)
  const probe = await runner.probeSession(false)
  assert.equal(probe.contract.currentModelId, accountModels[0].id, 'browser-authenticated models select the account route, not the API-key route')
  const events: any[] = []
  runner.on('event', event => events.push(event))
  await runner.startTurn('Return the fixture response.')
  assert.ok(modelRequests > 0)
  assert.ok(events.some(event => JSON.stringify(event).includes('account route verified')))
  assert.equal(events.some(event => event.type === 'error'), false)
  await runner.disposeAndWait(); runner = undefined
  console.log('PASS browser grant selects the account model route and authenticates a synthetic local model turn without an API key')
  await host.stop()
  const restarted = await host.start()
  assert.equal((await restarted.call<any>('account/getState')).status, 'credential-stored', 'native grant survives owned Host restart')
  await restarted.call('account/signOut', { client: metadata })
  assert.equal((await restarted.call<any>('account/getState')).status, 'signed-out')
  const waiting = restarted.stream<any>('account/watch', {}, AbortSignal.timeout(20000))
  await waiting.next()
  await restarted.call('account/startSignIn', { client: metadata, callbackOrigin: restarted.callbackOrigin, loginSource: 'desktop' })
  do { state = (await waiting.next()).value } while (state.attempt?.phase === 'initializing' || !state.attempt)
  assert.equal(state.attempt.phase, 'waiting-browser')
  await restarted.call('account/cancelSignIn', { attemptId: state.attempt.id })
  const late = await fetch(initialization.redirect_uri + '?state=' + encodeURIComponent(initialization.state) + '&code=late', { redirect: 'manual' })
  await late.body?.cancel()
  assert.notEqual(late.status, 302)
  assert.equal(exchanges, 1, 'cancelled attempt cannot exchange a late callback')
  assert.equal((await restarted.call<any>('account/getState')).status, 'signed-out')
  await waiting.return(undefined)
  console.log('PASS published Host account API: state validation, PKCE exchange, success stream, persistence, sign-out and cancelled callback')
} finally {
  await runner?.disposeAndWait()
  await host?.stop()
  platform.closeAllConnections()
  await new Promise<void>(resolve => platform.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
}
