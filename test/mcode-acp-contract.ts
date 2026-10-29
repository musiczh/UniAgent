import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ACPRunner, listMCodeSessions, loadMCodeSessionEvents } from '../src/main/acp/acpRunner.ts'
import * as runnerModule from '../src/main/acp/acpRunner.ts'
import {
  MCODE_PERMISSION_MODES,
  acpLaunchArgs,
  assertACPProviderConfig,
  projectACPContract
} from '../src/main/acp/acpProvider.ts'
import { parseMCodeCatalog } from '../src/main/mcodeCatalog.ts'
import { ACP_ADAPTERS, acpProviderFor, isACPAdapter } from '../src/main/acp/acpAdapters.ts'
import {
  MCODE_BIN,
  MCODE_PERMISSION_VALUES,
  mcodeModelLabel,
  mcodePermissionFromValue,
  parseMCodeModelValue
} from '../src/shared/mcode.ts'
import type { AgentDef } from '../src/shared/types.ts'

// ---------------------------------------------------------------------------
// 1. Shared contract: model encoding and permission mapping.
//
// Break caught: the model values MiniMax Code advertises are encoded strings
// (`m:<provider>:<model>:u` / `m:<provider>:<model>:v:<variant>`). Decoding
// them wrongly would show raw encoding strings in the model picker.
// ---------------------------------------------------------------------------

assert.deepEqual(parseMCodeModelValue('m:minimax:MiniMax-M3.1-Flash:v:thinking'), {
  providerId: 'minimax',
  modelId: 'MiniMax-M3.1-Flash',
  variant: 'thinking'
})
// The runtime advertises the non-thinking variant with an empty variant slot.
assert.deepEqual(parseMCodeModelValue('m:minimax:MiniMax-M3.1-Flash:v:'), {
  providerId: 'minimax',
  modelId: 'MiniMax-M3.1-Flash',
  variant: ''
})
assert.deepEqual(parseMCodeModelValue('m:minimax:MiniMax-M3:u'), {
  providerId: 'minimax',
  modelId: 'MiniMax-M3'
})
assert.equal(parseMCodeModelValue('grok-4.6'), undefined)
assert.equal(parseMCodeModelValue('m:minimax:MiniMax-M3'), undefined)
assert.equal(parseMCodeModelValue('m:minimax:MiniMax-M3:x'), undefined)
assert.equal(parseMCodeModelValue('m:minimax:MiniMax-M3:v:thinking:extra'), undefined)
assert.equal(parseMCodeModelValue(''), undefined)
assert.equal(parseMCodeModelValue(undefined), undefined)

assert.equal(mcodeModelLabel('m:minimax:MiniMax-M3.1-Flash:v:thinking'), 'MiniMax-M3.1-Flash · thinking')
assert.equal(mcodeModelLabel('m:minimax:MiniMax-M3.1-Flash:v:'), 'MiniMax-M3.1-Flash')
assert.equal(mcodeModelLabel('grok-4.6'), 'grok-4.6')
assert.equal(mcodeModelLabel(undefined), '')

// Break caught: a permission tier that is not one of the three the runtime
// accepts would be rejected with -32602 at the first prompt.
assert.deepEqual(MCODE_PERMISSION_VALUES, {
  ask: 'default',
  'approve-for-me': 'auto',
  'full-access': 'bypassPermissions'
})
assert.equal(mcodePermissionFromValue('default'), 'ask')
assert.equal(mcodePermissionFromValue('auto'), 'approve-for-me')
assert.equal(mcodePermissionFromValue('bypassPermissions'), 'full-access')
assert.equal(mcodePermissionFromValue('readonly'), undefined)

assert.equal(MCODE_BIN, 'mcode')

// ---------------------------------------------------------------------------
// 2. Adapter registry: a new provider must not silently inherit Grok's rules.
// ---------------------------------------------------------------------------

assert.ok(ACP_ADAPTERS.includes('mcode'))
assert.equal(isACPAdapter('mcode'), true)
assert.equal(isACPAdapter('codex'), false)
assert.equal(isACPAdapter(undefined), false)
assert.equal(acpProviderFor('mcode'), 'mcode')
assert.equal(acpProviderFor('grok'), 'grok')
assert.equal(acpProviderFor('codex'), undefined)

// Break caught: `mcode acp` is the only supported entry point; the runtime
// rejects every other flag with "unknown option".
assert.deepEqual(acpLaunchArgs('mcode', {} as never), ['acp'])

assert.deepEqual(MCODE_PERMISSION_MODES.map((mode) => mode.id), [
  'ask',
  'approve-for-me',
  'full-access'
])
assert.throws(
  () => assertACPProviderConfig('mcode', { permissionMode: 'read-only' } as never),
  /MiniMax Code 仅支持/
)
assert.doesNotThrow(() => assertACPProviderConfig('mcode', { permissionMode: 'approve-for-me' } as never))

// ---------------------------------------------------------------------------
// 3. Contract projection from the real `mcode 0.6.12` initialize response.
// ---------------------------------------------------------------------------

const realInitialize = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { image: true, audio: false, embeddedContext: false },
    sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} }
  },
  authMethods: [{ type: 'terminal', id: 'minimax-code-login', name: 'Sign in to MiniMax Code', args: ['login'] }],
  agentInfo: { name: 'minimax-code', title: 'MiniMax Code', version: '0.6.12' },
  _meta: {
    'minimax-code/extensions': {
      version: 1,
      methods: [
        'session/activate', 'mcode/session/activate', 'mcode/session/steer',
        'mcode/session/queue/list', 'mcode/session/queue/enqueue',
        'mcode/session/queue/update', 'mcode/session/queue/delete', 'mcode/session/queue/steer',
        'mcode/session/goal/get', 'mcode/session/goal/create', 'mcode/session/goal/patch', 'mcode/session/goal/clear',
        'mcode/session/delegation/get', 'mcode/session/delegation/stop'
      ],
      notifications: [
        'mcode/session/current_session_update', 'mcode/session/queue_update',
        'mcode/session/goal_update', 'mcode/session/delegation_update'
      ]
    }
  }
} as never

const realSessionResponse = {
  sessionId: 'mvs_7d391392ec544602acc3d950bc8dbc11',
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' }
    ]
  },
  configOptions: [
    {
      type: 'select', id: 'permissionMode', name: 'Permission mode', category: '_permission',
      currentValue: 'bypassPermissions',
      options: [
        { value: 'default', name: 'Ask' },
        { value: 'auto', name: 'Auto' },
        { value: 'bypassPermissions', name: 'Full access' }
      ],
      _meta: { 'minimax-code/scope': 'process' }
    },
    {
      type: 'select', id: 'model', name: 'Model', category: 'model',
      currentValue: 'm:minimax:MiniMax-M3.1-Flash:v:thinking',
      options: [
        { value: 'm:minimax:MiniMax-M3.1-Flash:v:', name: 'M3.1-Flash' },
        { value: 'm:minimax:MiniMax-M3.1-Flash:v:thinking', name: 'M3.1-Flash · thinking' },
        { value: 'm:minimax:MiniMax-M3:v:', name: 'M3' },
        { value: 'm:minimax:MiniMax-M3:v:thinking', name: 'M3 · thinking' }
      ]
    },
    {
      type: 'select', id: 'thinkingEffort', name: 'Thinking effort', category: 'thought_level',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Extra High' },
        { value: 'max', name: 'Max' }
      ]
    }
  ]
}

const contract = projectACPContract('mcode', realInitialize, realSessionResponse, { permissionMode: 'ask' } as never)

// Break caught: the model picker must show the runtime's own names and keep
// the encoded value as the id, otherwise the model cannot be selected again.
assert.deepEqual(contract.models.map((model) => ({ id: model.id, label: model.label })), [
  { id: 'm:minimax:MiniMax-M3.1-Flash:v:', label: 'M3.1-Flash' },
  { id: 'm:minimax:MiniMax-M3.1-Flash:v:thinking', label: 'M3.1-Flash · thinking' },
  { id: 'm:minimax:MiniMax-M3:v:', label: 'M3' },
  { id: 'm:minimax:MiniMax-M3:v:thinking', label: 'M3 · thinking' }
])
assert.equal(contract.currentModelId, 'm:minimax:MiniMax-M3.1-Flash:v:thinking')
// Break caught: the runtime advertises a "default" thinking level that is not
// an effort, and it describes the CURRENT model only. A "no thinking" variant
// has no reasoning level at all, so it must not offer one.
assert.deepEqual(contract.models[0].efforts, [])
assert.deepEqual(contract.models[1].efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
assert.deepEqual(contract.models[2].efforts, [])
assert.deepEqual(contract.models[3].efforts, [])
assert.equal(contract.models[0].defaultEffort, undefined)

// Break caught: MiniMax Code has no read-only tier; advertising one would
// let the user pick a mode the runtime rejects with -32602.
assert.deepEqual(contract.permissionModes.map((mode) => mode.id), ['ask', 'approve-for-me', 'full-access'])
assert.equal(contract.currentPermissionMode, 'ask')

assert.equal(contract.steer, true)
assert.equal(contract.nativeGoal, true)
assert.equal(contract.sessionFork, true)
assert.equal(contract.sessionList, true)
assert.equal(contract.sessionLoad, true)
assert.equal(contract.sessionResume, true)
assert.equal(contract.imageAttachments, true)
// `embeddedContext` is false in the real response: no inline resource blocks.
assert.equal(contract.fileAttachments, false)
// MiniMax Code does not advertise extra directories.
assert.equal(contract.additionalDirectoriesNew, false)
assert.equal(contract.additionalDirectoriesResume, false)
// Not alignable with the MiniMax Code protocol surface.
assert.equal(contract.sideChat, false)
assert.equal(contract.crossAgentFork, false)
assert.equal(contract.structuredSubagents, false)
assert.equal(contract.nativeReview, false)
assert.equal(contract.structuredUsage, false)
assert.equal(contract.capabilityInventory, false)
assert.deepEqual(contract.collaborationModes, ['default', 'plan'])

// ---------------------------------------------------------------------------
// 1b. Native catalog aware projection.
//
// MiniMax Code decides per model whether a "no thinking" variant exists, which
// reasoning levels it accepts and which context windows it offers. The ACP
// surface only describes the current model, so UniAgent has to read the native
// catalog; without it the projection must degrade instead of guessing.
// ---------------------------------------------------------------------------

const nativeCatalog = parseMCodeCatalog(`
logLevel: info
provider:
  minimax:
    name: MiniMax
    options:
      apiKey: sk-test
    models:
      MiniMax-M3:
        name: M3
        limit:
          context: 512000
          output: 128000
        contextWindowOptions:
          - 512000
          - 1000000
        thinking_config:
          mode: switchable
          default_value: 'true'
        variants:
          none-thinking:
            thinking:
              type: disabled
          thinking:
            thinking:
              type: adaptive
      MiniMax-M3.1-Flash:
        name: M3.1-Flash（订阅限免）
        limit:
          context: 512000
          output: 128000
        contextWindowOptions:
          - 512000
          - 1000000
        thinking:
          effortOptions:
            - default
            - low
            - medium
            - high
            - xhigh
            - max
          defaultEffort: default
        thinking_config:
          mode: forced_on
        variants:
          none-thinking:
            thinking:
              type: disabled
          thinking:
            thinking:
              type: adaptive
minimax_api:
  apiKey: sk-test
minimaxModelSource: minimax_api_key
defaultModel: minimax/MiniMax-M3.1-Flash
defaultModelVariant: thinking
`)

assert.ok(nativeCatalog)
assert.equal(nativeCatalog.credentialSource, 'api')
assert.equal(nativeCatalog.models.get('MiniMax-M3')?.defaultContextWindow, 512000)
assert.equal(nativeCatalog.models.get('MiniMax-M3')?.contextWindow, 512000)
assert.equal(nativeCatalog.models.get('MiniMax-M3')?.maxContextWindow, 1000000)
assert.equal(nativeCatalog.models.get('MiniMax-M3')?.supportsMax, true)
assert.equal(nativeCatalog.models.get('MiniMax-M3')?.thinkingMode, 'switchable')
assert.deepEqual(nativeCatalog.models.get('MiniMax-M3')?.effortOptions, undefined)
assert.equal(nativeCatalog.models.get('MiniMax-M3.1-Flash')?.thinkingMode, 'forced_on')
assert.deepEqual(nativeCatalog.models.get('MiniMax-M3.1-Flash')?.effortOptions, ['default', 'low', 'medium', 'high', 'xhigh', 'max'])

const catalogContract = projectACPContract('mcode', realInitialize, realSessionResponse, { permissionMode: 'ask' } as never, [], nativeCatalog)

// Break caught: a model that forces thinking on has no "no thinking" variant
// in the native app, so offering one in UniAgent is an invented capability.
assert.deepEqual(catalogContract.models.map((model) => model.id), [
  'm:minimax:MiniMax-M3.1-Flash:v:thinking',
  'm:minimax:MiniMax-M3:v:',
  'm:minimax:MiniMax-M3:v:thinking'
])
// Break caught: the reasoning levels belong to the model that declares them.
// M3 declares none, so it must not offer a reasoning level at all.
assert.deepEqual(catalogContract.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
assert.deepEqual(catalogContract.models[1].efforts, [])
assert.deepEqual(catalogContract.models[2].efforts, [])
// Break caught: the context window is a per-model capability the ACP surface
// never reports; without it the 1M switch could not be offered.
assert.equal(catalogContract.models[0].contextWindow, 512000)
assert.equal(catalogContract.models[0].maxContextWindow, 1000000)
assert.equal(catalogContract.models[0].supportsMax, true)
assert.equal(catalogContract.models[2].supportsMax, true)

// The active model stays visible even when the catalog hides its variant, so
// the picker never loses its selection.
const forcedOnCurrent = projectACPContract('mcode', realInitialize, {
  ...realSessionResponse,
  configOptions: realSessionResponse.configOptions.map((option: any) => option.id === 'model'
    ? { ...option, currentValue: 'm:minimax:MiniMax-M3.1-Flash:v:' }
    : option)
}, { permissionMode: 'ask' } as never, [], nativeCatalog)
assert.ok(forcedOnCurrent.models.some((model) => model.id === 'm:minimax:MiniMax-M3.1-Flash:v:'))

// Break caught: a CLI build without the extension must hide the feature
// instead of failing at call time.
const withoutExtensions = projectACPContract(
  'mcode',
  { ...(realInitialize as any), _meta: undefined } as never,
  realSessionResponse,
  { permissionMode: 'ask' } as never
)
assert.equal(withoutExtensions.steer, false)
assert.equal(withoutExtensions.nativeGoal, false)

// ---------------------------------------------------------------------------
// 4. Runner behaviour against a deterministic MiniMax Code ACP fixture.
// ---------------------------------------------------------------------------

const fixture = resolve(process.cwd(), 'test/fixtures/fake-mcode.cjs')

type JsonFrame = Record<string, any>

/** A `mcode` executable that forwards every argument to the fixture. */
async function createMCodeBin(dir: string): Promise<string> {
  const bin = join(dir, 'mcode')
  await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, 'utf8')
  await chmod(bin, 0o755)
  return bin
}

async function createFixtureEnv(dir: string, scenario: Record<string, unknown> = {}): Promise<NodeJS.ProcessEnv> {
  return {
    FAKE_MCODE_LOG: join(dir, 'protocol.jsonl'),
    FAKE_MCODE_STATE: join(dir, 'state.json'),
    FAKE_MCODE_SCENARIO: JSON.stringify(scenario)
  }
}

async function readFrames(dir: string): Promise<JsonFrame[]> {
  let raw = ''
  try {
    raw = await readFile(join(dir, 'protocol.jsonl'), 'utf8')
  } catch {
    return []
  }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error(`timeout waiting for ${label}`)
}

const mcodeAgent: AgentDef = {
  id: 'mcode',
  name: 'MiniMax Code',
  bin: 'mcode',
  adapter: 'mcode',
  icon: 'mcode',
  builtin: true,
  capabilities: {
    modelSelect: true,
    reasoningEffort: true,
    permissionModes: MCODE_PERMISSION_MODES
  },
  models: []
} as never

async function withRunner<T>(
  scenario: Record<string, unknown>,
  run: (context: {
    runner: InstanceType<typeof ACPRunner>
    dir: string
    events: any[]
    contracts: any[]
  }) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-mcode-contract-'))
  const bin = await createMCodeBin(dir)
  await writeFile(join(dir, 'state.json'), JSON.stringify({ sessions: [] }), 'utf8')
  const env = await createFixtureEnv(dir, scenario)
  const events: any[] = []
  const contracts: any[] = []
  const runner = new ACPRunner(
    `mcode-${Date.now()}`,
    { n: 0 },
    { ...mcodeAgent, bin } as AgentDef,
    { agentId: 'mcode', permissionMode: 'ask', workdir: dir } as never,
    undefined,
    env
  )
  runner.on('event', (event) => events.push(event))
  runner.on('contract', (contract) => contracts.push(structuredClone(contract)))
  try {
    return await run({ runner, dir, events, contracts })
  } finally {
    runner.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

// --- 4.1 A normal turn ------------------------------------------------------

await test('Plan selects the native session mode independently of permissions', async () => {
  await withRunner({}, async ({ runner, dir }) => {
    for (const mode of ['plan', 'default'] as const) {
      await runner.setCollaborationMode(mode)
      await runner.startTurn('Check native mode')
      const records = await readFrames(dir)
      const updates = records.filter(row => row.frame?.method === 'session/update' &&
        row.frame.params?.update?.sessionUpdate === 'current_mode_update')
      assert.equal(updates.at(-1)?.frame.params.update.currentModeId, mode)
      const requests = records.filter(row => row.kind === 'inbound')
      const modeIndex = requests.findLastIndex(row => row.frame?.method === 'session/set_mode')
      const promptIndex = requests.findLastIndex(row => row.frame?.method === 'session/prompt')
      assert.equal(requests[modeIndex]?.frame.params.modeId, mode)
      assert.ok(modeIndex >= 0 && modeIndex < promptIndex, 'mode must be applied before the prompt')
      const permissions = requests.filter(row => row.frame?.params?.configId === 'permissionMode')
      assert.equal(permissions.at(-1)?.frame.params.value, 'default', 'Plan must retain Ask permissions')
    }
  })
})

for (const scenario of [{ noPermissionOption: true }, { permissionUnsupported: true }]) {
  await test('permission policy must be confirmed before prompting: ' + JSON.stringify(scenario), async () => {
    await withRunner(scenario, async ({ runner, dir, events }) => {
      await runner.startTurn('must not execute with a more permissive policy')
      assert.ok(events.some(event => event.type === 'error'))
      assert.equal((await readFrames(dir)).some(row => row.frame?.method === 'session/prompt'), false)
    })
  })
}

await test('a paused or cleared Goal releases its turn and can resume', async () => {
  await withRunner({}, async ({ runner }) => {
    await runner.setGoal({ objective: 'pause and resume' })
    const paused = await runner.updateGoal({ action: 'pause' })
    assert.equal(paused?.autonomous, false)
    assert.equal(runner.isRunning(), false)
    await runner.updateGoal({ action: 'resume' })
    assert.equal(runner.isRunning(), true)
    await runner.updateGoal({ action: 'clear' })
    assert.equal(runner.isRunning(), false)
    await runner.startTurn('ordinary followup')
    assert.equal(runner.isRunning(), false)
  })
})

await test('Stop pauses the native Goal instead of only ending the local turn', async () => {
  await withRunner({}, async ({ runner }) => {
    await runner.setGoal({ objective: 'stop native execution' })
    runner.interrupt()
    await waitFor(async () => !runner.isRunning(), 'Goal stop')
    assert.equal((await runner.getGoal())?.status, 'paused')
  })
})

for (const [nativeStatus, status] of [['blocked', 'blocked'], ['budget_limited', 'budgetLimited'], ['usage_limited', 'usageLimited']] as const) {
  await test('native Goal settles at ' + nativeStatus, async () => {
    await withRunner({ goalFinalStatus: nativeStatus }, async ({ runner }) => {
      await runner.setGoal({ objective: 'terminal state' })
      await waitFor(async () => !runner.isRunning(), nativeStatus, 6000)
      const goal = await runner.getGoal()
      assert.equal(goal?.status, status)
      assert.equal(goal?.autonomous, false)
    })
  })
}

await withRunner({}, async ({ runner, dir, events, contracts }) => {
  await runner.startTurn('hello')
  const frames = await readFrames(dir)
  // The fixture logs what it receives as `inbound` (the runner's requests) and
  // what it sends as `outbound` (its replies and notifications).
  const requests = frames.filter((frame) => frame.kind === 'inbound').map((frame) => frame.frame)

  // Break caught: the ACP server is only reachable as `mcode acp`.
  assert.deepEqual(frames.filter((frame) => frame.kind === 'argv').map((frame) => frame.argv), [['acp']])

  const newSession = requests.find((frame) => frame.method === 'session/new')
  assert.ok(newSession, 'the runner must create a session')
  assert.equal(newSession.params.cwd, dir)
  assert.equal(newSession.params.mcpServers.length, 1)
  assert.equal(newSession.params.mcpServers[0].name, 'uniagent')
  assert.ok(
    newSession.params.mcpServers[0].env.find((entry: { name: string }) => entry.name === 'UNIAGENT_CALLER_SESSION')?.value,
    'the handoff MCP server must know which session called it'
  )

  assert.ok(events.some((event) => event.type === 'turn_started'))
  assert.equal(events.find((event) => event.type === 'reasoning')?.payload.text, 'Inspecting')
  assert.equal(events.find((event) => event.type === 'agent_message')?.payload.text, 'MiniMax Code reply')
  assert.ok(events.some((event) => event.type === 'command_exec'))
  assert.equal(events.at(-1)?.type, 'turn_completed')
  assert.equal(events.at(-1)?.state, 'success')

  // Break caught: the permission tier the user picked must reach the runtime
  // before the first prompt; otherwise the agent keeps the user's global
  // "full access" setting while UniAgent shows a stricter one.
  const setPermission = requests.find((frame) => frame.method === 'session/set_config_option' && frame.params?.configId === 'permissionMode')
  assert.ok(setPermission, 'the runner must push the permission mode down')
  assert.equal(setPermission.params.value, 'default')
  const permissionIndex = requests.findIndex((frame) => frame.method === 'session/set_config_option' && frame.params?.configId === 'permissionMode')
  const promptIndex = requests.findIndex((frame) => frame.method === 'session/prompt')
  assert.ok(permissionIndex >= 0 && promptIndex >= 0 && permissionIndex < promptIndex, 'permission mode must be set before the first prompt')

  assert.ok(contracts.at(-1)?.permissionModes.map((mode: any) => mode.id).includes('approve-for-me'))
})

// --- 4.2 The three permission tiers map onto the three runtime values -------

for (const [mode, expected] of [['ask', 'default'], ['approve-for-me', 'auto'], ['full-access', 'bypassPermissions']] as const) {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-mcode-permission-'))
  const bin = await createMCodeBin(dir)
  await writeFile(join(dir, 'state.json'), JSON.stringify({ sessions: [] }), 'utf8')
  const env = await createFixtureEnv(dir)
  const runner = new ACPRunner(
    `mcode-permission-${mode}`,
    { n: 0 },
    { ...mcodeAgent, bin } as AgentDef,
    { agentId: 'mcode', permissionMode: mode, workdir: dir } as never,
    undefined,
    env
  )
  try {
    await runner.startTurn('hello')
    const frames = await readFrames(dir)
    const setPermission = frames
      .filter((frame) => frame.kind === 'inbound')
      .map((frame) => frame.frame)
      .find((frame) => frame.method === 'session/set_config_option' && frame.params?.configId === 'permissionMode')
    if (setPermission) assert.equal(setPermission.params.value, expected, `permission mode ${mode} must map to ${expected}`)
    // The tier that is actually in force when the turn starts is what matters:
    // a mode that already matches the runtime needs no request at all.
    const effective = frames.find((frame) => frame.kind === 'effective-permission')
    assert.equal(effective?.value, expected, `the ${mode} tier must be in force for the turn`)
  } finally {
    runner.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

// --- 4.3 File changes are projected without an ACP `diff` block -------------

await withRunner({}, async ({ runner, dir, events }) => {
  await runner.startTurn('edit')
  const change = events.find((event) => event.type === 'file_change')
  assert.ok(change, 'a write tool call must produce a file change card')
  assert.deepEqual(change.payload.changes, [{
    path: '/fixture/workspace/marker.txt',
    kind: 'add',
    oldText: undefined,
    newText: 'hello\n'
  }])
  // Break caught: the generic tool projection would hide the write behind an
  // opaque tool call because MiniMax Code sends no `diff` block.
  assert.equal(events.some((event) => event.type === 'tool_call' && event.payload.id === 'call_function_write'), false)
  const frames = await readFrames(dir)
  assert.ok(frames.some((frame) => frame.kind === 'outbound'))
})

// --- 4.4 Permission requests use the MiniMax Code option ids ---------------

await withRunner({}, async ({ runner, dir, events }) => {
  const turn = runner.startTurn('permission')
  await waitFor(
    async () => events.some((event) => event.type === 'approval_request' && event.state === 'pending'),
    'permission request'
  )
  const request = events.find((event) => event.type === 'approval_request' && event.state === 'pending')
  assert.deepEqual(request.payload.options.map((option: any) => option.optionId), [
    'allow-once',
    'allow-always',
    'deny'
  ])
  assert.deepEqual(runner.respondResult(request.payload.requestId, {
    outcome: { outcome: 'selected', optionId: 'allow-always' }
  }), { handled: true, hasPendingRequests: false })
  await turn
  const frames = await readFrames(dir)
  const response = frames
    .filter((frame) => frame.kind === 'inbound')
    .map((frame) => frame.frame)
    .find((frame) => frame.id === 'permission-1' && frame.result)
  assert.deepEqual(response?.result, { outcome: { outcome: 'selected', optionId: 'allow-always' } })
})

// --- 4.5 Elicitation uses a different wire shape than a permission request --

await withRunner({}, async ({ runner, dir, events }) => {
  const turn = runner.startTurn('review')
  await waitFor(
    async () => events.some((event) => event.type === 'approval_request' && event.state === 'pending'),
    'elicitation request'
  )
  const request = events.find((event) => event.type === 'approval_request' && event.state === 'pending')
  assert.equal(request.payload.kind, 'elicitation')
  assert.equal(request.payload.method, 'elicitation/create')
  assert.equal(request.payload.params.requestedSchema.properties.decision.enum[0], 'accept')
  assert.deepEqual(runner.respondResult(request.payload.requestId, {
    action: 'accept',
    content: { decision: 'accept' }
  }), { handled: true, hasPendingRequests: false })
  await turn
  const frames = await readFrames(dir)
  const response = frames
    .filter((frame) => frame.kind === 'inbound')
    .map((frame) => frame.frame)
    .find((frame) => frame.id === 'elicitation-1' && frame.result)
  // Break caught: replying with the permission shape would make the runtime
  // reject the answer and the turn would never finish.
  assert.deepEqual(response?.result, { action: 'accept', content: { decision: 'accept' } })
})

// --- 4.6 Steering is only valid inside a running prompt turn ---------------

await withRunner({}, async ({ runner, dir, events }) => {
  const turn = runner.startTurn('steer')
  await waitFor(
    async () => {
      const frames = await readFrames(dir)
      return frames.some((frame) => frame.kind === 'inbound' && frame.frame?.method === 'session/prompt')
    },
    'prompt turn'
  )
  const steered = await runner.steer('改成中文回答')
  assert.equal(steered?.appendedToTurn, true)
  await turn
  const frames = await readFrames(dir)
  const steerRequest = frames
    .filter((frame) => frame.kind === 'inbound')
    .map((frame) => frame.frame)
    .find((frame) => frame.method === 'mcode/session/steer')
  assert.equal(steerRequest?.params?.text, '改成中文回答')
  assert.ok(events.some((event) => event.type === 'agent_message' && event.payload.text === 'Steered: 改成中文回答'))
})

await withRunner({}, async ({ runner }) => {
  // Break caught: steering outside a prompt turn would silently claim success
  // while the runtime never received the message.
  await assert.rejects(() => runner.steer('too early'), /当前没有可插话的 MiniMax Code 回合/)
})

// --- 4.7 Native goals map onto `mcode/session/goal/*` -----------------------

await withRunner({}, async ({ runner, dir, events }) => {
  const goals: any[] = []
  runner.on('goalChanged', (goal: any) => goals.push(goal))
  const goal = await runner.setGoal({ objective: '完成一个目标', tokenBudget: 20000 })
  assert.equal(goal.objective, '完成一个目标')
  assert.equal(goal.tokenBudget, 20000)
  assert.equal(goal.status, 'active')
  assert.equal(goal.continuation, 'native')

  const frames = await readFrames(dir)
  const created = frames
    .filter((frame) => frame.kind === 'inbound')
    .map((frame) => frame.frame)
    .find((frame) => frame.method === 'mcode/session/goal/create')
  assert.equal(created?.params?.objective, '完成一个目标')
  assert.equal(created?.params?.tokenBudget, 20000)

  // Break caught: `goal/create` starts the goal inside the runtime, so the
  // runner has to own a turn; otherwise the goal's event stream is dropped
  // and the session would never come back to idle.
  assert.ok(events.some((event) => event.type === 'turn_started'), 'the goal must open a runner owned turn')

  const fetched = await runner.getGoal()
  assert.equal(fetched?.objective, '完成一个目标')

  const paused = await runner.updateGoal({ action: 'pause' })
  assert.equal(paused?.status, 'paused')
  const resumed = await runner.updateGoal({ action: 'resume' })
  assert.equal(resumed?.status, 'active')
  const edited = await runner.updateGoal({ action: 'edit', objective: '改过的目标' })
  assert.equal(edited?.objective, '改过的目标')
  const cleared = await runner.updateGoal({ action: 'clear' })
  assert.equal(cleared, undefined)

  const after = await readFrames(dir)
  const methods = after
    .filter((frame) => frame.kind === 'inbound')
    .map((frame) => frame.frame?.method)
    .filter((method: string) => method?.startsWith('mcode/session/goal/'))
  assert.deepEqual(methods, [
    'mcode/session/goal/create',
    'mcode/session/goal/get',
    'mcode/session/goal/patch',
    'mcode/session/goal/patch',
    'mcode/session/goal/patch',
    'mcode/session/goal/clear'
  ])
  assert.ok(goals.length >= 1)
})

// --- 4.8 A settled goal closes the runner owned turn ------------------------

await withRunner({ goalCompletes: true }, async ({ runner, dir, events }) => {
  await runner.setGoal({ objective: '完成一个目标' })
  // The runtime drives the goal; the runner learns about it by polling
  // `mcode/session/goal/get` because MiniMax Code never notifies progress.
  await waitFor(
    async () => events.some((event) => event.type === 'turn_completed'),
    'the goal turn to be closed',
    15_000
  )
  const turnCompleted = events.find((event) => event.type === 'turn_completed')
  assert.equal(turnCompleted?.state, 'success')
  const frames = await readFrames(dir)
  const polls = frames
    .filter((frame) => frame.kind === 'inbound')
    .map((frame) => frame.frame)
    .filter((frame) => frame.method === 'mcode/session/goal/get')
  assert.ok(polls.length >= 1, 'the goal status must be polled')
  runner.dispose()
})

// --- 4.9 History listing and replay ----------------------------------------

await withRunner({}, async ({ runner, dir }) => {
  await runner.startTurn('hello')
  runner.dispose()

  const listDir = await mkdtemp(join(tmpdir(), 'uniagent-mcode-history-'))
  const listBin = await createMCodeBin(listDir)
  await writeFile(join(listDir, 'state.json'), JSON.stringify({ sessions: [] }), 'utf8')
  const listEnv = await createFixtureEnv(listDir)
  // The fixture keeps the session in its own state file; copy it over so the
  // history read sees the session the runner created.
  await writeFile(join(listDir, 'state.json'), await readFile(join(dir, 'state.json'), 'utf8'), 'utf8')
  try {
    const sessions = await listMCodeSessions(listBin, listDir, listEnv)
    assert.ok(sessions.length >= 1)
    assert.equal(sessions[0].agentId, 'mcode')
    assert.ok(sessions[0].id.startsWith('mvs_'))

    const loaded = await loadMCodeSessionEvents(sessions[0].id, listBin, listDir, listEnv)
    // The session keeps the workspace it was created in, not the folder the
    // history was read from.
    assert.equal(loaded.cwd, dir)
    assert.ok(loaded.events.some((event) => event.type === 'user_message' && event.payload.text === 'hello'))
    assert.ok(loaded.events.some((event) => event.type === 'agent_message' && event.payload.text === 'MiniMax Code reply'))
  } finally {
    await rm(listDir, { recursive: true, force: true })
  }
})

// --- 4.10 The runtime has no native delete --------------------------------

// Break caught: `session/delete` is not implemented by MiniMax Code; exposing
// a delete button would delete nothing while telling the user it did.
assert.equal(
  Object.keys(runnerModule).filter((name) => /^delete.*MCode|^deleteMCode/i.test(name)).length,
  0,
  'MiniMax Code must not offer native session deletion'
)

const deleteDir = await mkdtemp(join(tmpdir(), 'uniagent-mcode-delete-'))
const deleteBin = await createMCodeBin(deleteDir)
await writeFile(join(deleteDir, 'state.json'), JSON.stringify({ sessions: [] }), 'utf8')
const deleteEnv = await createFixtureEnv(deleteDir)
{
  const { ACPConnection } = await import('../src/main/acp/acpConnection.ts')
  const connection = new ACPConnection({
    bin: deleteBin,
    args: ['acp'],
    cwd: deleteDir,
    env: { ...process.env, ...deleteEnv },
    providerLabel: 'MiniMax Code',
    validateInitialize: () => {}
  })
  try {
    await connection.initialize()
    await assert.rejects(
      () => connection.request('session/delete', { sessionId: 'mvs_x' }),
      (error: any) => error.code === -32601
    )
  } finally {
    await connection.closeAndWait()
    await rm(deleteDir, { recursive: true, force: true })
  }
}

console.log('mcode-acp-contract: shared contracts ok')
