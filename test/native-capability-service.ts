import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeCapabilityService } from '../src/main/nativeCapabilityService.ts'
import type { AgentDef } from '../src/shared/types.ts'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const codexAgent: AgentDef = {
  id: 'codex', name: 'Codex', bin: 'codex', adapter: 'codex', icon: '', builtin: true,
  capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] },
  models: [], installed: true, version: '0.148.0'
}

test('Claude reads native session usage without submitting a user turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniagent-claude-usage-'))
  const executable = join(root, 'probe.cjs')
  const log = join(root, 'requests.jsonl')
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const v=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
if(v.type==='user')process.exit(2);
const subtype=v.request.subtype; const data=subtype==='initialize'?{commands:[]}:subtype==='get_context_usage'?{model:'claude-sonnet-4-5',totalTokens:1500,rawMaxTokens:200000,percentage:0.75}:subtype==='get_usage'?{session:{total_cost_usd:0.1,model_usage:{}},subscription_type:null,rate_limits_available:false,rate_limits:null,behaviors:null}:{};
process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:data}})+'\\n');});
`, { mode: 0o700 })
  const service = new NativeCapabilityService()
  try {
    const result = await (service as any).queryClaudeUsage({ ...codexAgent, id: 'claude', adapter: 'claude', bin: executable }, root, 'native-session')
    assert.deepEqual(result, {
      contextUsage: { model: 'claude-sonnet-4-5', totalTokens: 1500, rawMaxTokens: 200000, percentage: 0.75 },
      usageReport: { session: { total_cost_usd: 0.1, model_usage: {} }, subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null }
    })
    const wire = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(wire[0].request.subtype, 'initialize')
    assert.deepEqual(wire.slice(1).map((item) => item.request), [
      { subtype: 'get_context_usage', detail: 'summary' }, { subtype: 'get_usage', skip_behaviors: true }
    ])
    assert.equal(wire.some((item) => item.type === 'user'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function createService(
  respond: (method: string, params: unknown) => unknown | Promise<unknown>,
  options?: { mcpSelectionSettleMs?: number; mcpSelectionPollMs?: number }
) {
  const calls: Array<{ method: string; params: unknown }> = []
  let starts = 0
  let disposes = 0
  const service = new NativeCapabilityService(() => ({
    start: async () => { starts++ },
    notify: () => undefined,
    request: async (method: string, params: unknown) => {
      calls.push({ method, params })
      return respond(method, params)
    },
    dispose: async () => { disposes++ }
  }) as never, options)
  return { service, calls, stats: () => ({ starts, disposes }) }
}

test('skips provider discovery when no native capability is selected', async () => {
  const { service, calls, stats } = createService(() => {
    throw new Error('provider discovery must not run')
  })

  assert.equal(
    await service.resolveSelection(codexAgent, '/repo', { candidateIds: [] }),
    undefined
  )
  assert.deepEqual(calls, [])
  assert.deepEqual(stats(), { starts: 0, disposes: 0 })
})

test('DeepSeek exposes its declared native Goal and Plan in command discovery', async () => {
  const service = new NativeCapabilityService()
  const snapshot = await service.discover({ ...codexAgent, id: 'deepseek', adapter: 'deepseek', capabilities: {
    ...codexAgent.capabilities, nativeGoal: true, collaborationModes: ['default', 'plan'], commands: ['help', 'compact']
  } }, '/repo')
  assert.equal(snapshot.actions.goal, true)
  assert.equal(snapshot.actions.plan?.id, 'plan')
  assert.deepEqual(snapshot.candidates.map((candidate) => candidate.id), ['command:help', 'command:compact'])
})

test('discovers provider-native candidates across MCP pages and preserves provider startup states', async () => {
  const { service, calls, stats } = createService((method, params) => {
    if (method === 'initialize') return {}
    if (method === 'skills/list') return {
      data: [{ cwd: '/repo', skills: [
        { name: 'docs', description: 'Docs', path: '/skills/docs/SKILL.md', scope: 'user', enabled: true },
        { name: 'disabled', path: '/skills/disabled/SKILL.md', enabled: false }
      ], errors: [] }]
    }
    if (method === 'mcpServerStatus/list') {
      const cursor = (params as { cursor?: string | null }).cursor
      return cursor
        ? { data: [{ name: 'failed-server', startupStatus: { status: 'failed', message: 'connection refused' }, authStatus: 'oAuth', tools: {}, resources: [], resourceTemplates: [] }], nextCursor: null }
        : { data: [
          { name: 'figma', startup_status: 'starting', authStatus: 'oAuth', tools: { read_file: { name: 'read_file' } }, resources: [], resourceTemplates: [] },
          { name: 'auth', startupStatus: { state: 'ready', message: 'signed in' }, authStatus: 'notLoggedIn', tools: {}, resources: [], resourceTemplates: [] },
          { name: 'cancelled', status: 'cancelled', authStatus: 'unsupported', tools: {}, resources: [], resourceTemplates: [] },
          { name: 'uniagent', authStatus: 'oAuth', tools: {}, resources: [], resourceTemplates: [] }
        ], nextCursor: 'next-page' }
    }
    if (method === 'collaborationMode/list') return { data: [{ name: 'Plan', mode: 'plan', model: 'gpt-5.6-sol', reasoning_effort: 'high' }] }
    throw new Error(method)
  })

  const snapshot = await service.discover(codexAgent, '/repo', true)

  assert.deepEqual(calls.map(({ method }) => method), [
    'initialize', 'skills/list', 'mcpServerStatus/list', 'collaborationMode/list', 'mcpServerStatus/list'
  ])
  assert.deepEqual(calls.filter(({ method }) => method === 'mcpServerStatus/list').map(({ params }) => params), [
    { cursor: null, limit: 100, detail: 'toolsAndAuthOnly' },
    { cursor: 'next-page', limit: 100, detail: 'toolsAndAuthOnly' }
  ])
  assert.deepEqual(snapshot.candidates.map((item) => item.id), [
    'skill:/skills/docs/SKILL.md', 'mcp:figma', 'mcp:auth', 'mcp:cancelled', 'mcp:failed-server'
  ])
  assert.deepEqual(snapshot.candidates.filter((item) => item.kind === 'mcp').map((item) =>
    ({ name: item.name, startupStatus: item.startupStatus, statusMessage: item.statusMessage, toolNames: item.toolNames })
  ), [
    { name: 'figma', startupStatus: 'starting', statusMessage: undefined, toolNames: ['read_file'] },
    { name: 'auth', startupStatus: 'auth-required', statusMessage: 'signed in', toolNames: [] },
    { name: 'cancelled', startupStatus: 'cancelled', statusMessage: undefined, toolNames: [] },
    { name: 'failed-server', startupStatus: 'failed', statusMessage: 'connection refused', toolNames: [] }
  ])
  assert.equal(snapshot.actions.goal, true)
  assert.equal(snapshot.actions.review, true)
  assert.deepEqual(snapshot.actions.plan, { id: 'plan', name: 'Plan', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  assert.deepEqual(stats(), { starts: 1, disposes: 1 })
})

test('refreshes before resolving selection and rejects forged or unavailable candidates as a whole', async () => {
  let unavailable = false
  const { service } = createService((method) => {
    if (method === 'initialize' || method === 'collaborationMode/list') return { data: [] }
    if (method === 'skills/list') return { data: [{ skills: [{ name: 'docs', path: '/skills/docs/SKILL.md', enabled: true }] }] }
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'figma', startupStatus: unavailable ? 'failed' : 'ready', authStatus: 'oAuth', tools: {}, resources: [], resourceTemplates: [] }], nextCursor: null }
    throw new Error(method)
  })

  assert.deepEqual(await service.resolveSelection(codexAgent, '/repo', {
    candidateIds: ['skill:/skills/docs/SKILL.md', 'mcp:figma']
  }), {
    skills: [{ name: 'docs', path: '/skills/docs/SKILL.md' }],
    mcpServers: [{ name: 'figma' }]
  })
  await assert.rejects(
    service.resolveSelection(codexAgent, '/repo', { candidateIds: ['skill:/tmp/forged/SKILL.md'] }),
    /候选已失效/
  )
  unavailable = true
  await assert.rejects(
    service.resolveSelection(codexAgent, '/repo', { candidateIds: ['skill:/skills/docs/SKILL.md', 'mcp:figma'] }),
    /MCP Server 当前不可用/
  )
})

test('keeps one provider probe alive until a selected MCP finishes starting', async () => {
  let mcpRequests = 0
  const { service, stats } = createService((method) => {
    if (method === 'initialize' || method === 'collaborationMode/list') return { data: [] }
    if (method === 'skills/list') return { data: [{ skills: [] }] }
    if (method === 'mcpServerStatus/list') {
      mcpRequests++
      return {
        data: [{
          name: 'isolated_fixture',
          startupStatus: mcpRequests === 1 ? 'starting' : 'ready',
          authStatus: 'unsupported',
          tools: {},
          resources: [],
          resourceTemplates: []
        }],
        nextCursor: null
      }
    }
    throw new Error(method)
  })

  assert.deepEqual(
    await service.resolveSelection(codexAgent, '/repo', {
      candidateIds: ['mcp:isolated_fixture']
    }),
    { skills: [], mcpServers: [{ name: 'isolated_fixture' }] }
  )
  assert.equal(mcpRequests, 2, 'the selected MCP must settle on the original app-server probe')
  assert.deepEqual(stats(), { starts: 1, disposes: 1 })
})

test('bounds a selected MCP status request that stalls after starting', async () => {
  let mcpRequests = 0
  const { service, stats } = createService((method) => {
    if (method === 'initialize' || method === 'collaborationMode/list') return { data: [] }
    if (method === 'skills/list') return { data: [{ skills: [] }] }
    if (method === 'mcpServerStatus/list') {
      mcpRequests++
      if (mcpRequests > 1) return new Promise(() => undefined)
      return {
        data: [{
          name: 'isolated_fixture',
          startupStatus: 'starting',
          authStatus: 'unsupported',
          tools: {},
          resources: [],
          resourceTemplates: []
        }],
        nextCursor: null
      }
    }
    throw new Error(method)
  }, { mcpSelectionSettleMs: 20, mcpSelectionPollMs: 1 })

  let testTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await assert.rejects(
      Promise.race([
        service.resolveSelection(codexAgent, '/repo', {
          candidateIds: ['mcp:isolated_fixture']
        }),
        new Promise((_, reject) => {
          testTimer = setTimeout(() => reject(new Error('selected MCP exceeded its hard deadline')), 200)
        })
      ]),
      /MCP Server 当前不可用/
    )
  } finally {
    if (testTimer) clearTimeout(testTimer)
  }
  assert.equal(mcpRequests, 2)
  assert.deepEqual(stats(), { starts: 1, disposes: 1 })
})

test('does not issue another MCP status page request after the selected settle deadline', async () => {
  const realNow = Date.now
  let now = 0
  let mcpRequests = 0
  Date.now = () => now
  try {
    const { service, stats } = createService((method) => {
      if (method === 'initialize' || method === 'collaborationMode/list') return { data: [] }
      if (method === 'skills/list') return { data: [{ skills: [] }] }
      if (method === 'mcpServerStatus/list') {
        mcpRequests++
        return Promise.resolve().then(() => {
          now = 11
          return {
            data: [{
              name: 'isolated_fixture',
              startupStatus: 'starting',
              authStatus: 'unsupported',
              tools: {},
              resources: [],
              resourceTemplates: []
            }],
            nextCursor: 'late-page'
          }
        })
      }
      throw new Error(method)
    }, { mcpSelectionSettleMs: 10, mcpSelectionPollMs: 1 })

    await assert.rejects(
      service.resolveSelection(codexAgent, '/repo', {
        candidateIds: ['mcp:isolated_fixture']
      }),
      /候选已失效/
    )
    assert.equal(mcpRequests, 1, 'deadline must be checked before issuing the next provider request')
    assert.deepEqual(stats(), { starts: 1, disposes: 1 })
  } finally {
    Date.now = realNow
  }
})

test('keys cache by agent identity, binary, version and workdir while force and invalidate bypass it', async () => {
  let requests = 0
  const { service } = createService((method) => {
    if (method === 'initialize') return {}
    if (method === 'skills/list') { requests++; return { data: [{ skills: [] }] } }
    if (method === 'mcpServerStatus/list' || method === 'collaborationMode/list') return { data: [], nextCursor: null }
    throw new Error(method)
  })
  const updated = { ...codexAgent, version: '0.149.0' }
  const movedBinary = { ...codexAgent, bin: '/tools/codex' }

  await service.discover(codexAgent, '/repo')
  await service.discover(codexAgent, '/repo')
  await service.discover(codexAgent, '/other')
  await service.discover(updated, '/repo')
  await service.discover(movedBinary, '/repo')
  await service.discover(codexAgent, '/repo', true)
  service.invalidate('codex', '/repo')
  await service.discover(codexAgent, '/repo')

  assert.equal(requests, 6)
})

test('returns a short-lived empty snapshot when provider discovery fails', async () => {
  const { service, stats } = createService((method) => {
    if (method === 'initialize') throw new Error('provider offline')
    throw new Error(method)
  })

  const snapshot = await service.discover(codexAgent, '/repo', true)
  assert.deepEqual(snapshot, {
    agentId: 'codex', workdir: '/repo', source: 'provider-native', candidates: [],
    actions: { goal: false, review: false, plan: null }, errors: ['provider offline']
  })
  assert.deepEqual(stats(), { starts: 1, disposes: 1 })
})

test('coalesces concurrent capability discovery, including forced refreshes', async () => {
  for (const force of [false, true]) {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { service, stats } = createService(async method => {
      if (method === 'initialize') { await gate; return {} }
      return { data: [], nextCursor: null }
    })
    const pending = Array.from({ length: 20 }, () => service.discover(codexAgent, '/repo', force))
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(stats().starts, 1, 'one scope must not start twenty app-server processes')
    } finally { release(); await Promise.all(pending) }
    assert.equal(stats().disposes, 1)
  }
})

test('live MCP status updates preserve the catalog cache and authentication requirements', async () => {
  const { service, stats } = createService(method => method === 'mcpServerStatus/list'
    ? { data: [
      { name: 'figma', startupStatus: 'starting', authStatus: 'oAuth', tools: { inspect: {} } },
      { name: 'auth', authStatus: 'notLoggedIn', tools: {} }
    ] }
    : { data: [] })
  await service.discover(codexAgent, '/repo')
  service.applyMcpStatus('codex', '/repo', 'figma', 'ready')
  service.applyMcpStatus('codex', '/repo', 'auth', 'ready')
  const snapshot = await service.discover(codexAgent, '/repo')
  assert.equal(stats().starts, 1, 'startup notifications must not trigger a second provider probe')
  const figma = snapshot.candidates.find(candidate => candidate.id === 'mcp:figma')!
  assert.equal(figma.kind === 'mcp' && figma.startupStatus, 'ready')
  assert.deepEqual(figma.kind === 'mcp' && figma.toolNames, ['inspect'])
  const auth = snapshot.candidates.find(candidate => candidate.id === 'mcp:auth')!
  assert.equal(auth.kind === 'mcp' && auth.startupStatus, 'auth-required')
})

test('serializes invalidated discovery and never caches an obsolete generation', async () => {
  type Gate = { resolve: (value: unknown) => void; promise: Promise<unknown> }
  const gates: Gate[] = []
  const gate = (): Gate => {
    let resolve!: (value: unknown) => void
    const promise = new Promise<unknown>((done) => { resolve = done })
    return { resolve, promise }
  }
  let attempts = 0
  const { service } = createService((method) => {
    if (method === 'initialize') return {}
    if (method === 'skills/list') {
      attempts++
      const next = gate()
      gates.push(next)
      return next.promise
    }
    if (method === 'mcpServerStatus/list' || method === 'collaborationMode/list') return { data: [], nextCursor: null }
    throw new Error(method)
  })

  const stale = service.discover(codexAgent, '/repo')
  await new Promise((resolve) => setImmediate(resolve))
  service.invalidate('codex', '/repo')
  gates[0].resolve({ data: [{ skills: [{ name: 'stale', path: '/skills/stale/SKILL.md', enabled: true }] }] })
  assert.deepEqual((await stale).candidates.map((candidate) => candidate.id), ['skill:/skills/stale/SKILL.md'])

  const afterInvalidation = service.discover(codexAgent, '/repo')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(gates.length, 2, 'an invalidated in-flight result must not populate the cache')
  gates[1]!.resolve({ data: [{ skills: [{ name: 'fresh', path: '/skills/fresh/SKILL.md', enabled: true }] }] })
  assert.deepEqual((await afterInvalidation).candidates.map((candidate) => candidate.id), ['skill:/skills/fresh/SKILL.md'])

  const older = service.discover(codexAgent, '/repo', true)
  await new Promise((resolve) => setImmediate(resolve))
  service.invalidate('codex', '/repo')
  const newer = service.discover(codexAgent, '/repo', true)
  const joined = service.discover(codexAgent, '/repo', true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(gates.length, 3, 'a new generation must wait until the old probe has closed')
  gates[2].resolve({ data: [{ skills: [{ name: 'older', path: '/skills/older/SKILL.md', enabled: true }] }] })
  assert.deepEqual((await older).candidates.map((candidate) => candidate.id), ['skill:/skills/older/SKILL.md'])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(gates.length, 4, 'all invalidation notifications share one follow-up probe')
  gates[3].resolve({ data: [{ skills: [{ name: 'newer', path: '/skills/newer/SKILL.md', enabled: true }] }] })
  assert.deepEqual((await newer).candidates.map((candidate) => candidate.id), ['skill:/skills/newer/SKILL.md'])
  assert.deepEqual(await joined, await newer)
  assert.deepEqual((await service.discover(codexAgent, '/repo')).candidates.map((candidate) => candidate.id), ['skill:/skills/newer/SKILL.md'])
  assert.equal(attempts, 4, 'the newest cache entry must avoid a fifth provider request')
})
