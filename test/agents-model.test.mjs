import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as agentModels from '../src/main/agents.ts'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const { BUILTIN_AGENTS, resolveClaudeModels } = agentModels

test('a Kimi cleanup failure settles only after cleanup and lets other agents finish independently', { timeout: 10000 }, async (t) => {
  const require = createRequire(import.meta.url)
  const { build } = createRequire(require.resolve('electron-vite'))('esbuild')
  const stubs = {
    './kimiWebService.ts': 'export const kimiWebEnvironment=env=>env; export const acquireKimiWebService=async()=>globalThis.lease;',
    './kimiInstallation.ts': 'export const findKimiExecutable=async()=>"/fixture/kimi";',
    './deepseekService.ts': 'export const detectDeepSeek=async agent=>({...agent,installed:false});',
    './mcodeService.ts': 'export const detectMCode=async agent=>({...agent,installed:false});',
    './nika/runtime.ts': 'export const NIKA_MODES=[]; export const detectNika=async agent=>({...agent,installed:false});',
    './acp/acpRunner.ts': 'export const GROK_PERMISSION_MODES=[]; export const probeGrokACP=async()=>({status:"uninstalled"});',
    './zcode/runtime': 'export const importPreparedZCodeRuntime=async()=>{}; export const getZCodeRuntimeSnapshot=async()=>({phase:"missing"});'
  }
  const result = await build({
    entryPoints: ['src/main/agents.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
    plugins: [{ name: 'isolated-agent-probes', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    } }]
  })
  const context = vm.createContext({ module: { exports: {} }, require, process, console, Buffer, setTimeout, clearTimeout, URL, AbortController })
  context.exports = context.module.exports
  vm.runInContext(result.outputFiles[0].text, context)
  let releases = 0
  let releaseCleanup
  const cleanup = new Promise(resolve => { releaseCleanup = resolve })
  t.after(() => releaseCleanup())
  context.lease = {
    version: '2.2.0',
    transport: { verifyProtocol: async () => {}, request: async (_method, path) => path.endsWith('/auth') ? { models_ready: true } : { items: [] } },
    release: async () => { releases++; await cleanup; throw new Error('kimi_web_shutdown_inspection') }
  }
  const isolated = context.module.exports
  for (const agent of isolated.BUILTIN_AGENTS) agent.bin = '/missing/uniagent-fixture/' + agent.id
  const completed = []
  let grokCompleted
  const grokReady = new Promise(resolve => { grokCompleted = resolve })
  let settled = false
  const detection = isolated.detectAgents('all', undefined, agent => {
    completed.push(agent.id)
    if (agent.id === 'grok') grokCompleted()
  }).then(agents => { settled = true; return agents })
  await grokReady
  assert.equal(settled, false, '较快的 Agent 应先完成，不等待 Kimi 清理结束')
  assert.equal(completed.includes('kimi'), false, 'Kimi 清理结果未确认时不能提前发布可用或失败')
  releaseCleanup()
  const agents = await detection
  assert.equal(completed.filter(id => id === 'kimi').length, 1)
  assert.equal(agents.length, BUILTIN_AGENTS.length)
  assert.deepEqual(new Set(agents.map(agent => agent.id)), new Set(BUILTIN_AGENTS.map(agent => agent.id)))
  const kimi = agents.find(agent => agent.id === 'kimi')
  assert.equal(kimi.lifecycle.detectionStatus, 'failed')
  assert.equal(kimi.lifecycle.availability, 'unhealthy')
  assert.match(kimi.lifecycle.detectionError, /退出状态无法确认/)
  assert.ok(agents.filter(agent => agent.id !== 'kimi').every(agent => !agent.lifecycle?.detectionStatus))
  context.lease.release = async () => { releases++ }
  const retried = await isolated.detectAgents('all', 'kimi')
  assert.deepEqual(Array.from(retried, agent => agent.id), ['kimi'])
  assert.equal(retried[0].installed, true)
  assert.equal(retried[0].lifecycle?.detectionStatus, undefined)
  assert.equal(releases, 2)
})

test('Codex ignores the legacy runtime override and never changes process environment', () => {
  const env = { CODEX_CLI_PATH: '/tmp/hybrid-codex', CODEX_HYBRID_CODEX_BIN: '/Applications/Codex.app/codex' }
  const before = { ...env }
  assert.equal(agentModels.resolveCodexRuntimeBin('/opt/homebrew/bin/codex', env), '/opt/homebrew/bin/codex')
  assert.deepEqual(env, before)
  assert.equal('applyCodexRuntimePath' in agentModels, false)
})

test('app-server probing closes stdin for router-style launchers', async (t) => {
  assert.equal(typeof agentModels.probeAppServer, 'function')
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-codex-probe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const server = join(dir, 'fake-router')
  await writeFile(server, '#!/bin/sh\n/bin/cat >/dev/null\n', 'utf8')
  await chmod(server, 0o755)

  assert.equal(await agentModels.probeAppServer(server, 3000), true)
})

test('Codex models come from the complete app-server catalog', async (t) => {
  assert.equal(typeof agentModels.loadCodexModels, 'function')
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-codex-models-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const server = join(dir, 'fake-codex')
  await writeFile(server, `#!/usr/bin/env node
const readline = require('node:readline')
const pages = {
  first: {
    data: [{
      id: 'gpt-native', model: 'gpt-native', displayName: 'GPT Native', hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'high', contextWindow: 123000,
      serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }]
    }],
    nextCursor: 'traex'
  },
  traex: {
    data: [{
      id: 'traex::DeepSeek-V4-Pro', model: 'traex::DeepSeek-V4-Pro',
      displayName: 'TraeX · DeepSeek-V4-Pro', hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      defaultReasoningEffort: 'medium'
    }],
    nextCursor: null
  }
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n')
  } else if (message.method === 'model/list') {
    const page = message.params && message.params.cursor === 'traex' ? pages.traex : pages.first
    process.stdout.write(JSON.stringify({ id: message.id, result: page }) + '\\n')
  }
})
`, 'utf8')
  await chmod(server, 0o755)

  let nativeIds = []
  agentModels.configureCodexModelsProvider(nativeModels => {
    nativeIds = nativeModels.map(model => model.id)
    return [...nativeModels, { id: 'kimi-for-coding', label: 'kimi-for-coding', efforts: ['high'] }]
  })
  t.after(() => agentModels.configureCodexModelsProvider())
  const models = await agentModels.loadCodexModels(server)
  assert.deepEqual(nativeIds, ['gpt-native', 'traex::DeepSeek-V4-Pro'], '必须先读取 Codex 原生动态目录，再合并补充模型')
  assert.deepEqual(models, [
    {
      id: 'gpt-native', label: 'GPT Native', efforts: ['low', 'high'], defaultEffort: 'high',
      contextWindow: 123000, maxContextWindow: undefined, supportsMax: false, loadPercent: undefined,
      supportsFast: true
    },
    {
      id: 'traex::DeepSeek-V4-Pro', label: 'TraeX · DeepSeek-V4-Pro', efforts: ['medium'],
      defaultEffort: 'medium', contextWindow: undefined, maxContextWindow: undefined, supportsMax: false,
      loadPercent: undefined, supportsFast: false
    },
    { id: 'kimi-for-coding', label: 'kimi-for-coding', efforts: ['high'] }
  ])
})

test('TraeX reasoning efforts come from its app-server catalog', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-traex-models-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const server = join(dir, 'fake-traex')
  await writeFile(server, `#!/usr/bin/env node
if (process.argv[2] === 'models') {
  process.stdout.write('Fake-Sol\\n')
  process.exit(0)
}
const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n')
  } else if (message.method === 'model/list') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {
      data: [{
        id: 'fake-sol', model: 'Fake-Sol', displayName: 'Fake Sol', hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' }, { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }
        ],
        defaultReasoningEffort: 'medium'
      }],
      nextCursor: null
    } }) + '\\n')
  }
})
`, 'utf8')
  await chmod(server, 0o755)

  const models = await agentModels.loadTraexModels(server)
  assert.deepEqual(models, [{
    id: 'Fake-Sol', label: 'Fake Sol', efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium', contextWindow: undefined, maxContextWindow: undefined,
    supportsMax: false, loadPercent: undefined, supportsFast: false
  }])
})

test('Claude model names override backend routing aliases', () => {
  const named = resolveClaudeModels({
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'gpt-5.6-sol',
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'gpt-5.6-sol',
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'gpt-5.6-sol',
    CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-5.6-sol'
  })
  assert.deepEqual(named.models.map(({ id }) => id), ['gpt-5.6-sol'])
  assert.equal(named.defaultModel, 'gpt-5.6-sol')

  const routed = resolveClaudeModels({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6' })
  assert.deepEqual(routed.models.map(({ id }) => id), ['claude-sonnet-4-6'])
})

test('Claude models come from the SDK initialize response with real versions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-claude-models-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cli = join(dir, 'fake-claude')
  await writeFile(cli, `#!/usr/bin/env node
const readline = require('node:readline')
const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.request?.subtype !== 'initialize') return
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'hook_started' }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { models: [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: efforts },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: efforts },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable · Requires usage credits', supportsEffort: true, supportedEffortLevels: efforts },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Most efficient for everyday tasks', supportsEffort: true, supportedEffortLevels: efforts },
    { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: efforts }
  ] } } }) + '\\n')
})
`, 'utf8')
  await chmod(cli, 0o755)

  const models = await agentModels.loadClaudeCliModels(cli)
  assert.deepEqual(models.map(({ id, label, efforts, defaultEffort, contextWindow }) => [id, label, efforts.length, defaultEffort, contextWindow]), [
    ['opus', 'Opus 5.5', 5, 'medium', undefined],
    ['claude-fable-5-1[1m]', 'Fable 5.1', 5, 'high', undefined],
    ['haiku', 'Haiku 4.5', 0, undefined, undefined],
    ['sonnet', 'Sonnet 5', 5, 'high', undefined],
    ['claude-opus-4-8', 'Opus 4.8', 5, 'high', undefined]
  ])

  const exited = join(dir, 'exited-claude')
  await writeFile(exited, '#!/bin/sh\nexit 1\n', 'utf8')
  await chmod(exited, 0o755)
  await assert.rejects(agentModels.loadClaudeCliModels(exited), /process exited with code 1/)
})

test('Plan is a collaboration mode for Codex and TraeX but remains a Claude permission', () => {
  const modes = Object.fromEntries(
    BUILTIN_AGENTS
      .filter(({ id }) => id === 'codex' || id === 'traex' || id === 'claude')
      .map(({ id, capabilities }) => [id, capabilities.permissionModes.map(({ id: mode }) => mode)])
  )

  assert.deepEqual(modes.codex, ['read-only', 'ask', 'approve-for-me', 'full-access'])
  assert.deepEqual(modes.traex, INTERNAL_DISTRIBUTION ? ['read-only', 'ask', 'approve-for-me', 'full-access'] : undefined)
  assert.deepEqual(modes.claude, ['plan', 'ask', 'auto-edit', 'approve-for-me', 'deny-unapproved', 'full-access'])
})

test('Grok is a protocol-native built-in with only the verified safe permission choices', () => {
  const grok = BUILTIN_AGENTS.find(({ id }) => id === 'grok')
  assert.ok(grok)
  assert.equal(grok.adapter, 'grok')
  assert.equal(grok.bin, 'grok')
  assert.equal(grok.capabilities.protocol, 'acp')
  assert.equal(grok.capabilities.streaming, true)
  assert.equal(grok.capabilities.imageAttachments, false)
  assert.equal(grok.capabilities.fileAttachments, false)
  assert.deepEqual(grok.capabilities.permissionModes.map(({ id }) => id), [
    'ask', 'full-access'
  ])
  assert.equal(grok.capabilities.permissionModes.some(({ id }) => id === 'auto-edit'), false)
  assert.deepEqual(grok.models, [], 'models remain session-scoped until an authenticated ACP probe')
})
