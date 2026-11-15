// Opt-in real Codex app-server + production router/adapter. Uses encrypted saved
// credentials only and spends a small number of Kimi/DeepSeek inference calls.
// UNIAGENT_REAL_PROVIDERS=1 node test/cdp-codex-provider-switch.mjs
// Also test GPT → Kimi → DeepSeek → GPT: add UNIAGENT_REAL_CODEX_NATIVE=1.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const loopback = process.env.UNIAGENT_CODEX_LOOPBACK === '1'
assert.ok(loopback || process.env.UNIAGENT_REAL_PROVIDERS === '1', 'Explicit paid-provider or isolated loopback opt-in is required')
const realHome = homedir(), originalEnv = { ...process.env }
const includeNative = process.env.UNIAGENT_REAL_CODEX_NATIVE === '1'
const nativeModel = process.env.UNIAGENT_CODEX_NATIVE_MODEL || 'gpt-6.1-sol'
const fixture = await mkdtemp(join(tmpdir(), 'ua-codex-provider-switch-'))
const bundle = resolve('.test-build/codex-provider-switch-live.mjs')
await build({ stdin: { contents: `
export {CodexSourceService,codexSourceRuntimeArgs} from './src/main/codexSourceService';
export {startCodexSourceRouter} from './src/main/codexSourceRouter';
export {AppServerRunner,configureCodexAppServerArgsProvider} from './src/main/appServerAdapter';
export {AppServerRpcClient} from './src/main/appServerTransport';
export {parseCodexModelKey} from './src/shared/codexModelIdentity';
`, resolveDir: process.cwd() }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const sweeper = createAcceptanceProcessSweeper({ includePgid: false, termGraceMs: 1500, killDeadlineMs: 8000 })
const checks = [], requests = [], failures = [], runners = [], rounds = []
let completedNativeTurns = 0
let router, service, runtimeApi, modelServer, secrets = [], activeProvider, expectedMarker = ''
const localRequests = []
const nativeOperations = []
const overflowMarkers = new Set()
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[API Key]'), String(value))
function check(label, value) { assert.ok(value, label); checks.push(label); console.log('✓ ' + label) }
try {
  process.env.UNIAGENT_USER_DATA = join(realHome, 'Library/Application Support/UniAgent')
  let connections
  if (loopback) {
    modelServer = createServer(async (req, res) => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json')
        if (req.url.includes('/responses')) {
          res.writeHead(426)
          res.end(JSON.stringify({ error: { message: 'Use HTTP streaming for this fixture.' } })); return
        }
        res.end(JSON.stringify({ data: ['k3', 'k3-next', 'deepseek-flash'].map(id => ({ id })) })); return
      }
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw), id = 'resp-' + (localRequests.length + 1)
      const input = JSON.stringify(body.input)
      const markers = [...new Set(input.match(/(?:SWITCH|ROUND)_[a-f0-9]+/g) || [])]
      const overflow = input.includes('OVERFLOW_RECOVERY_TEST') && !overflowMarkers.has(markers[0])
      localRequests.push({ model: body.model, effort: body.reasoning?.effort, markers, path: req.url, overflow })
      if (overflow || req.url.includes('/compact')) {
        if (overflow) overflowMarkers.add(markers[0])
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Your input exceeds the context window of this model.', code: 'context_length_exceeded', type: 'invalid_request_error' } })); return
      }
      const text = markers.join(' ') || 'Done'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type, payload) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
      const item = { id: 'msg-' + id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
      send('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } })
      send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
      send('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text })
      const last = JSON.stringify(body.input?.at(-1))
      if (last?.includes('STREAM_CANCEL_TEST')) {
        const timer = setInterval(() => send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: ' STREAM_CANCEL_TEST' }), 50)
        res.on('close', () => clearInterval(timer)); return
      }
      send('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text })
      send('response.output_item.done', { output_index: 0, item })
      send('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })
      res.end()
    })
    await new Promise(done => modelServer.listen(0, '127.0.0.1', done))
    const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`
    connections = [['kimi-code', 'k3'], ['deepseek', 'deepseek-flash']].map(([preset, model]) => ({ preset, model, apiKey: 'fixture-key', baseUrl }))
  } else {
  const credentialsBundle = resolve('.test-build/codex-switch-credentials.mjs')
  await build({ entryPoints: ['src/main/claudeSourceService.ts'], outfile: credentialsBundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const { ClaudeSourceService } = await import(credentialsBundle)
  const saved = new ClaudeSourceService()
  connections = await Promise.all([['kimi', 'k3'], ['deepseek', 'deepseek-flash']].map(([id, model]) =>
    saved.connection({ agentId: 'claude', workdir: fixture, model: `uniagent-model:third-party:${id}:${model}` })))
  secrets = connections.map(connection => connection.apiKey)
  const origins = { 'kimi-code': 'https://api.kimi.com/coding', deepseek: 'https://api.deepseek.com/anthropic' }
  connections.forEach(connection => assert.equal(connection.baseUrl.replace(/\/$/, ''), origins[connection.preset], 'Only official source credentials may be mapped to the official Responses endpoint'))
  }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, { PATH: originalEnv.PATH, LANG: 'en_US.UTF-8', HOME: join(fixture, 'home'), USERPROFILE: join(fixture, 'home'),
    SHELL: '/bin/sh', UNIAGENT_USER_DATA: join(fixture, 'data'), CODEX_HOME: join(fixture, 'home/.codex'),
    XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'xdg'), XDG_CACHE_HOME: join(fixture, 'cache'),
    TMPDIR: join(fixture, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'),
    npm_config_userconfig: join(fixture, 'npmrc'), npm_config_cache: join(fixture, 'npm') })
  for (const directory of [process.env.HOME, process.env.CODEX_HOME, process.env.UNIAGENT_USER_DATA, process.env.TMPDIR, join(fixture, 'workspace')]) await mkdir(directory, { recursive: true })
  await writeFile(process.env.GIT_CONFIG_GLOBAL, ''); await writeFile(process.env.npm_config_userconfig, '')
  if (includeNative && loopback) await writeFile(join(process.env.CODEX_HOME, 'auth.json'), '{"OPENAI_API_KEY":"fixture-key"}', { mode: 0o600 })
  if (includeNative && !loopback) {
    const nativeHome = originalEnv.CODEX_HOME || join(realHome, '.codex')
    for (const name of ['auth.json', 'models_cache.json']) {
      const content = await readFile(join(nativeHome, name), 'utf8')
      if (name === 'auth.json') {
        const auth = JSON.parse(content)
        secrets.push(...[auth.OPENAI_API_KEY, ...Object.values(auth.tokens || {})].filter(value => typeof value === 'string' && value.length > 20))
      }
      await writeFile(join(process.env.CODEX_HOME, name), content, { mode: 0o600 })
    }
  }
  // Runtime modules own singleton diagnostics/history paths; import only after isolation.
  runtimeApi = await import(bundle)
  const { CodexSourceService, codexSourceRuntimeArgs, startCodexSourceRouter, AppServerRunner,
    configureCodexAppServerArgsProvider, AppServerRpcClient, parseCodexModelKey } = runtimeApi
  service = new CodexSourceService()
  // Keep production validation, encrypted storage and catalog generation. A
  // dynamic in-process router avoids touching the user's fixed port/service.
  service.spawnChild = async () => {}
  for (const connection of connections) await service.save({ id: connection.preset === 'deepseek' ? 'deepseek' : 'kimi', preset: connection.preset,
    enabled: true, apiKey: connection.apiKey, baseUrl: loopback ? connection.baseUrl : connection.preset === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.kimi.com/coding/v1', models: loopback && connection.preset === 'kimi-code' ? [connection.model, 'k3-next'] : [connection.model] })
  router = await startCodexSourceRouter({ ...service.activeRouterConfig, port: 0 }, event => {
    if (event.type === 'service-issue' || event.type === 'model-issue') failures.push(redact(JSON.stringify(event)))
  })
  router.on('request', request => {
    let text = ''
    request.on('data', chunk => { text += chunk })
    request.on('end', () => {
      if (!request.url.endsWith('/responses')) return
      const body = JSON.parse(text)
      requests.push({ provider: request.url.split('/')[4], model: body.model, hasMarker: !!expectedMarker && text.includes(expectedMarker) })
    })
  })
  configureCodexAppServerArgsProvider(config => {
    if (config.modelSource?.kind !== 'third-party') return loopback ? ['-c', `openai_base_url="http://127.0.0.1:${modelServer.address().port}/v1"`] : []
    const selected = parseCodexModelKey(config.model)
    return codexSourceRuntimeArgs(`http://127.0.0.1:${router.address().port}/api/codex/v1/${selected.source.sourceId}`,
      join(process.env.UNIAGENT_USER_DATA, 'codex-sources', `models-${selected.source.sourceId}.json`), selected.source.sourceId, selected.model)
  })
  const agent = { id: 'codex', name: 'Codex', adapter: 'codex', bin: await realpath(originalEnv.UNIAGENT_CODEX_REAL_BIN || '/opt/homebrew/bin/codex'), builtin: true, models: [],
    capabilities: { modelSelect: true, reasoningEffort: true, streaming: true, permissionModes: [{ id: 'full-access', label: '', hint: '' }] } }
  const configs = Object.fromEntries(connections.map(connection => {
    const id = connection.preset === 'deepseek' ? 'deepseek' : 'kimi'
    return [id, { agentId: 'codex', workdir: join(fixture, 'workspace'), permissionMode: 'full-access', effort: 'low',
      model: `uniagent-model:third-party:${id}:${connection.model}`, modelSource: { kind: 'third-party', sourceId: id } }]
  }))
  configs.gpt = { agentId: 'codex', workdir: join(fixture, 'workspace'), permissionMode: 'full-access', effort: 'low',
    model: nativeModel, modelSource: { kind: 'native' } }
  const factory = options => {
    const wire = new AppServerRpcClient(options), start = wire.start.bind(wire)
    wire.start = async () => { await start(); await sweeper.addRoot(wire.processId()) }
    const request = wire.requestSequenced.bind(wire)
    wire.requestSequenced = async (method, params) => {
      const response = await request(method, params), result = response.result
      if (['thread/fork', 'thread/resume', 'thread/archive', 'turn/start'].includes(method)) nativeOperations.push({ method,
        threadId: params.threadId, modelProvider: params.modelProvider, resultThreadId: result?.thread?.id,
        inputCount: params.input?.length })
      return response
    }
    return wire
  }
  const addRunner = runner => {
    runner.setInitialTitleGenerationPolicy(() => false)
    runners.push(runner)
  }
  async function turn(runner, prompt, cancel = false) {
    const events = [], before = requests.length
    let interrupted = false, timer
    const listener = event => {
      events.push(event)
      if (cancel && !interrupted && event.type === 'agent_message' && event.payload.text) { interrupted = true; runner.interrupt() }
    }
    runner.on('event', listener)
    try {
      const done = new Promise((resolve, reject) => {
        runner.once('done', resolve)
        timer = setTimeout(() => { runner.interrupt(); reject(new Error('real provider turn timeout')) }, 120000)
      })
      await runner.startTurn(prompt)
      const result = await done
      assert.ok(!result.failed, redact(JSON.stringify(events.filter(event => event.type === 'error'))))
      if (cancel) assert.ok(interrupted && result.interrupted, 'stream cancellation must be acknowledged')
      const calls = requests.slice(before)
      if (activeProvider === 'gpt') {
        check('gpt: native turn completes without third-party routing', calls.length === 0 && !result.interrupted)
        completedNativeTurns++
      } else {
        check(activeProvider + ': request model/provider and history match', calls.length > 0 && calls.every(call => call.provider === activeProvider && call.model === parseCodexModelKey(configs[activeProvider].model).model && call.hasMarker))
      }
      return events.filter(event => event.type === 'agent_message').map(event => event.payload.text || '').join('\n')
    } finally { clearTimeout(timer); runner.off('event', listener) }
  }
  for (const [from, to] of [['deepseek', 'kimi'], ['kimi', 'deepseek']]) {
    expectedMarker = 'SWITCH_' + randomBytes(6).toString('hex')
    activeProvider = from
    const runner = new AppServerRunner('switch-' + from, { n: 0 }, agent, configs[from], undefined, undefined, factory)
    addRunner(runner)
    const first = await turn(runner, `Remember this marker for later turns: ${expectedMarker}. Reply with only this marker. Do not use tools.`)
    check(from + ': first turn marker', first.includes(expectedMarker))
    const nativeId = runner.nativeThreadId()
    const budget = await runner.getContextTokens(configs[to])
    check(from + ' → ' + to + ': portable context fits target', typeof budget === 'number' && budget < 900000)
    await runner.applyProviderConfig(configs[to], 996147)
    activeProvider = to
    check(from + ' → ' + to + ': same host runner forks native history', runner.nativeThreadId() !== nativeId)
    const resumed = await turn(runner, 'What exact marker did I ask you to remember? Reply with only that marker. Do not use tools.')
    check(from + ' → ' + to + ': real model remembers prior turn', resumed.includes(expectedMarker))
    await turn(runner, 'Output 100 numbered lines saying STREAM_CANCEL_TEST. Do not use tools.', true)
    check(to + ': generation cancelled', true)
    await runner.applyProviderConfig(configs[from], 996147)
    activeProvider = from
    const recovered = await turn(runner, 'Stop the numbered list. Reply with only the exact marker I first asked you to remember. Do not use tools.')
    check(to + ' → ' + from + ': switch after interruption forks and keeps context', recovered.includes(expectedMarker) && runner.nativeThreadId() !== nativeId)
    runner.dispose()
  }
  // Every hop completes normally. Each provider adds a fresh marker so the final
  // reply must preserve intermediate turns as well as the original conversation.
  for (const chain of [['kimi', 'deepseek', 'kimi'], ...(includeNative ? [['gpt', 'kimi', 'deepseek', 'gpt']] : [])]) {
    activeProvider = chain[0]
    const markers = []
    const runner = new AppServerRunner('roundtrip-' + chain[0], { n: 0 }, agent, configs[activeProvider], undefined, undefined, factory)
    addRunner(runner)
    let nativeId
    for (const [index, provider] of chain.entries()) {
      if (index) {
        const budget = await runner.getContextTokens(configs[provider])
        check(chain.join(' → ') + ': context fits hop ' + index, typeof budget === 'number' && budget < 200000)
        await runner.applyProviderConfig(configs[provider])
      }
      activeProvider = provider
      const marker = 'ROUND_' + randomBytes(6).toString('hex')
      markers.push(marker); expectedMarker = markers[0]
      const answer = await turn(runner, `Add this new marker to our conversation: ${marker}. Reply with every ROUND_ marker from ALL user messages in this conversation, in chronological order, separated by spaces. Do not use tools.`)
      check(chain.join(' → ') + ': hop ' + index + ' replies with all accumulated markers', markers.every(value => answer.includes(value)))
      check(chain.join(' → ') + ': hop ' + index + ' keeps host session with the provider native thread', !!runner.nativeThreadId() && (!index || runner.nativeThreadId() !== nativeId))
      nativeId = runner.nativeThreadId()
      rounds.push({ chain, hop: index, provider, model: configs[provider].model, completed: true, recalledMarkers: markers.length, sameHostSession: true, nativeThreadId: nativeId })
    }
    runner.dispose()
  }
  if (loopback) {
    if (includeNative) for (const side of [false, true]) {
      expectedMarker = 'SWITCH_' + randomBytes(6).toString('hex'); activeProvider = 'gpt'
      const sessionId = 'overflow-' + (side ? 'side' : 'main')
      const parent = new AppServerRunner(sessionId, { n: 0 }, agent, configs.gpt, undefined, undefined, factory)
      addRunner(parent)
      await turn(parent, 'Remember this marker: ' + expectedMarker)
      const parentId = parent.nativeThreadId()
      let runner = parent
      if (side) {
        const fork = await parent.rpc('thread/fork', { threadId: parentId, ephemeral: false, excludeTurns: true,
          model: nativeModel, modelProvider: 'openai', cwd: configs.gpt.workdir, approvalPolicy: 'never', sandbox: 'danger-full-access' })
        runner = new AppServerRunner(sessionId, { n: 0 }, agent, configs.gpt, fork.thread.id, undefined, factory)
        runner.setForkPreparation(async () => { throw new Error('existing side branch must not be recreated') }, parent)
        addRunner(runner)
      }
      const originalId = runner.nativeThreadId(), before = nativeOperations.length
      const binding = join(fixture, 'overflow-' + (side ? 'side' : 'main') + '.json')
      let rebound = 0
      runner.on('nativeThreadRebound', id => {
        rebound++
        writeFileSync(binding, JSON.stringify({ sessionId, nativeSessionId: id }), { mode: 0o600 })
        nativeOperations.push({ method: 'host/binding', threadId: id })
      })
      const answer = await turn(runner, 'OVERFLOW_RECOVERY_TEST: Recall the marker without tools.')
      const operations = nativeOperations.slice(before), forks = operations.filter(row => row.method === 'thread/fork')
      check(sessionId + ': real overflow recovers through local and normal Provider forks',
        forks.length === 2 && forks[0].modelProvider === 'uniagent-portable-openai' && forks[1].modelProvider === 'openai')
      check(sessionId + ': recovered reply preserves the marker', answer.includes(expectedMarker))
      check(sessionId + ': normal binding is confirmed before the empty retry', rebound === 1 &&
        JSON.parse(await readFile(binding, 'utf8')).nativeSessionId === runner.nativeThreadId() &&
        operations.findIndex(row => row.method === 'host/binding') < operations.findLastIndex(row => row.method === 'turn/start') &&
        operations.filter(row => row.method === 'turn/start').at(-1).inputCount === 0)
      check(sessionId + ': temporary branch is archived', operations.some(row => row.method === 'thread/archive' && row.threadId === forks[0].resultThreadId))
      check(sessionId + ': normal branch has a new identity', runner.nativeThreadId() !== originalId)
      if (side) check(sessionId + ': parent branch remains unchanged', parent.nativeThreadId() === parentId &&
        operations.filter(row => row.method === 'thread/fork' || row.method === 'turn/start').every(row => row.threadId !== parentId))
      const restoredId = runner.nativeThreadId(); await runner.waitForDisposal()
      const restored = new AppServerRunner(sessionId, { n: 0 }, agent, configs.gpt, restoredId, undefined, factory)
      addRunner(restored)
      if (side) restored.setForkPreparation(async () => { throw new Error('cold side must retain its binding') }, parent)
      check(sessionId + ': cold restore resumes the normal branch and history', await restored.ensureThreadReady() === restoredId &&
        (await turn(restored, 'Recall the marker without tools.')).includes(expectedMarker))
      await restored.waitForDisposal(); await parent.waitForDisposal()
    }
    expectedMarker = 'SWITCH_' + randomBytes(6).toString('hex'); activeProvider = 'kimi'
    const runner = new AppServerRunner('same-provider', { n: 0 }, agent, configs.kimi, undefined, undefined, factory)
    addRunner(runner)
    await turn(runner, 'Remember ' + expectedMarker)
    const nativeId = runner.nativeThreadId(), original = configs.kimi
    configs.kimi = { ...original, model: 'uniagent-model:third-party:kimi:k3-next' }
    await runner.applyProviderConfig(configs.kimi)
    check('same Provider model change retains native Thread', runner.nativeThreadId() === nativeId)
    await turn(runner, 'Recall the marker')
    await runner.waitForDisposal()
    const restored = new AppServerRunner('same-provider', { n: 0 }, agent, configs.kimi, nativeId, undefined, factory)
    addRunner(restored)
    check('cold restore retains native Thread', await restored.ensureThreadReady() === nativeId)
    check('cold restore carries complete input history', (await turn(restored, 'Recall the marker')).includes(expectedMarker))
    configs.kimi = original
    await restored.waitForDisposal()
    check('all isolated model requests use low effort', localRequests.every(call => call.effort === 'low'))
  }
  console.log('Real Codex cross-provider switching and interruption recovery passed')
} catch (error) {
  failures.push(redact(error.stack || error)); throw new Error(redact(error.message))
} finally {
  await Promise.all(runners.map(runner => runner.waitForDisposal()))
  runtimeApi?.configureCodexAppServerArgsProvider()
  await service?.close(); await sweeper.sweep()
  router?.closeAllConnections(); if (router?.listening) await new Promise(done => router.close(done))
  modelServer?.closeAllConnections(); if (modelServer?.listening) await new Promise(done => modelServer.close(done))
  await mkdir(resolve('.uniagent-artifacts'), { recursive: true })
  await writeFile(resolve(loopback ? '.uniagent-artifacts/codex-provider-switch-loopback.json' : '.uniagent-artifacts/codex-provider-switch-live.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, requests, rounds, failures, loopback, localRequests, nativeOperations, nativeModel: includeNative ? nativeModel : undefined, completedNativeTurns }, null, 2))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  assert.equal((await sweeper.ownedProcesses()).length, 0)
}
