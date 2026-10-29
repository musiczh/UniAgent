// Opt-in real Codex app-server + production router/adapter. Uses encrypted saved
// credentials only and spends a small number of Kimi/DeepSeek inference calls.
// UNIAGENT_REAL_PROVIDERS=1 node test/cdp-codex-provider-switch.mjs
// Also test GPT → Kimi → DeepSeek → GPT: add UNIAGENT_REAL_CODEX_NATIVE=1.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

assert.equal(process.env.UNIAGENT_REAL_PROVIDERS, '1', 'Explicit paid-provider opt-in is required')
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
let router, service, runtimeApi, secrets = [], activeProvider, expectedMarker = ''
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[API Key]'), String(value))
function check(label, value) { assert.ok(value, label); checks.push(label); console.log('✓ ' + label) }
try {
  process.env.UNIAGENT_USER_DATA = join(realHome, 'Library/Application Support/UniAgent')
  const credentialsBundle = resolve('.test-build/codex-switch-credentials.mjs')
  await build({ entryPoints: ['src/main/claudeSourceService.ts'], outfile: credentialsBundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const { ClaudeSourceService } = await import(credentialsBundle)
  const saved = new ClaudeSourceService()
  const connections = await Promise.all([['kimi', 'k3'], ['deepseek', 'deepseek-flash']].map(([id, model]) =>
    saved.connection({ agentId: 'claude', workdir: fixture, model: `uniagent-model:third-party:${id}:${model}` })))
  secrets = connections.map(connection => connection.apiKey)
  const origins = { 'kimi-code': 'https://api.kimi.com/coding', deepseek: 'https://api.deepseek.com/anthropic' }
  connections.forEach(connection => assert.equal(connection.baseUrl.replace(/\/$/, ''), origins[connection.preset], 'Only official source credentials may be mapped to the official Responses endpoint'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, { PATH: originalEnv.PATH, LANG: 'en_US.UTF-8', HOME: join(fixture, 'home'), USERPROFILE: join(fixture, 'home'),
    SHELL: '/bin/sh', UNIAGENT_USER_DATA: join(fixture, 'data'), CODEX_HOME: join(fixture, 'home/.codex'),
    XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'xdg'), XDG_CACHE_HOME: join(fixture, 'cache'),
    TMPDIR: join(fixture, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'),
    npm_config_userconfig: join(fixture, 'npmrc'), npm_config_cache: join(fixture, 'npm') })
  for (const directory of [process.env.HOME, process.env.CODEX_HOME, process.env.UNIAGENT_USER_DATA, process.env.TMPDIR, join(fixture, 'workspace')]) await mkdir(directory, { recursive: true })
  await writeFile(process.env.GIT_CONFIG_GLOBAL, ''); await writeFile(process.env.npm_config_userconfig, '')
  if (includeNative) {
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
    enabled: true, apiKey: connection.apiKey, baseUrl: connection.preset === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.kimi.com/coding/v1', models: [connection.model] })
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
    if (config.modelSource?.kind !== 'third-party') return []
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
    return wire
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
    runners.push(runner)
    const first = await turn(runner, `Remember this marker for later turns: ${expectedMarker}. Reply with only this marker. Do not use tools.`)
    check(from + ': first turn marker', first.includes(expectedMarker))
    const nativeId = runner.nativeThreadId()
    const budget = await runner.getContextTokens(configs[to])
    check(from + ' → ' + to + ': portable context fits target', typeof budget === 'number' && budget < 900000)
    await runner.applyProviderConfig(configs[to], 996147)
    activeProvider = to
    check(from + ' → ' + to + ': native session retained', runner.nativeThreadId() === nativeId)
    const resumed = await turn(runner, 'What exact marker did I ask you to remember? Reply with only that marker. Do not use tools.')
    check(from + ' → ' + to + ': real model remembers prior turn', resumed.includes(expectedMarker))
    await turn(runner, 'Output 100 numbered lines saying STREAM_CANCEL_TEST. Do not use tools.', true)
    check(to + ': generation cancelled', true)
    await runner.applyProviderConfig(configs[from], 996147)
    activeProvider = from
    const recovered = await turn(runner, 'Stop the numbered list. Reply with only the exact marker I first asked you to remember. Do not use tools.')
    check(to + ' → ' + from + ': switch after interruption keeps context', recovered.includes(expectedMarker) && runner.nativeThreadId() === nativeId)
    runner.dispose()
  }
  // Every hop completes normally. Each provider adds a fresh marker so the final
  // reply must preserve intermediate turns as well as the original conversation.
  for (const chain of [['kimi', 'deepseek', 'kimi'], ...(includeNative ? [['gpt', 'kimi', 'deepseek', 'gpt']] : [])]) {
    activeProvider = chain[0]
    const markers = []
    const runner = new AppServerRunner('roundtrip-' + chain[0], { n: 0 }, agent, configs[activeProvider], undefined, undefined, factory)
    runners.push(runner)
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
      nativeId ||= runner.nativeThreadId()
      check(chain.join(' → ') + ': hop ' + index + ' replies with all accumulated markers', markers.every(value => answer.includes(value)))
      check(chain.join(' → ') + ': hop ' + index + ' retains native session', !!nativeId && runner.nativeThreadId() === nativeId)
      rounds.push({ chain, hop: index, provider, model: configs[provider].model, completed: true, recalledMarkers: markers.length, sameSession: true })
    }
    runner.dispose()
  }
  console.log('Real Codex cross-provider switching and interruption recovery passed')
} catch (error) {
  failures.push(redact(error.stack || error)); throw new Error(redact(error.message))
} finally {
  runners.forEach(runner => runner.dispose())
  runtimeApi?.configureCodexAppServerArgsProvider()
  await service?.close(); await sweeper.sweep()
  router?.closeAllConnections(); if (router?.listening) await new Promise(done => router.close(done))
  await mkdir(resolve('.uniagent-artifacts'), { recursive: true })
  await writeFile(resolve('.uniagent-artifacts/codex-provider-switch-live.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, requests, rounds, failures, nativeModel: includeNative ? nativeModel : undefined, completedNativeTurns }, null, 2))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  assert.equal((await sweeper.ownedProcesses()).length, 0)
}
