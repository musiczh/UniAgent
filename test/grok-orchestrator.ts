import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { GROK_PERMISSION_MODES } from '../src/main/grokACPRunner.ts'
import type { AgentDef, Session, SessionConfig, UAEvent } from '../src/shared/types.ts'

type JsonRecord = Record<string, any>

type FakeGrok = {
  dir: string
  workdir: string
  bin: string
  logPath: string
  statePath: string
  storePath: string
  cleanup: () => Promise<void>
}

async function createFakeGrok(scenario: JsonRecord = {}): Promise<FakeGrok> {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-grok-orchestrator-'))
  const workdir = join(dir, 'workspace')
  const bin = join(dir, 'grok')
  const logPath = join(dir, 'protocol.jsonl')
  const statePath = join(dir, 'state.json')
  const storePath = join(dir, 'sessions.json')
  const fixture = resolve(process.cwd(), 'test/fixtures/fake-grok.cjs')
  await mkdir(workdir)
  await writeFile(statePath, JSON.stringify({ sessions: [] }), 'utf8')
  await writeFile(
    bin,
    `#!/usr/bin/env node
process.env.FAKE_GROK_LOG = ${JSON.stringify(logPath)}
process.env.FAKE_GROK_STATE = ${JSON.stringify(statePath)}
process.env.FAKE_GROK_SCENARIO = ${JSON.stringify(JSON.stringify(scenario))}
require(${JSON.stringify(fixture)})
`,
    'utf8'
  )
  await chmod(bin, 0o755)
  return {
    dir,
    workdir,
    bin,
    logPath,
    statePath,
    storePath,
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

function makeAgent(bin: string): AgentDef {
  return {
    id: 'grok',
    name: 'Grok',
    bin,
    adapter: 'grok',
    icon: 'grok',
    builtin: true,
    installed: true,
    lifecycle: {
      availability: 'available',
      auth: 'authenticated',
      health: 'healthy',
      selfUpdateSupported: true,
      updateStatus: 'idle',
      checkedAt: 1
    },
    capabilities: {
      modelSelect: true,
      attachments: true,
      reasoningEffort: true,
      permissionModes: GROK_PERMISSION_MODES.map((mode) => ({ ...mode })),
      streaming: true,
      imageAttachments: false,
      fileAttachments: true,
      sessionList: true,
      sessionLoad: true,
      sessionResume: true,
      sessionFork: false,
      protocol: 'acp'
    },
    models: [{
      id: 'grok-4.6',
      label: 'Grok 4.6',
      efforts: ['xhigh', 'high', 'medium', 'low'],
      defaultEffort: 'high',
      contextWindow: 500000
    }],
    defaultModel: 'grok-4.6'
  }
}

function makeConfig(workdir: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    agentId: 'grok',
    model: 'grok-4.6',
    effort: 'high',
    permissionMode: 'ask',
    collaborationMode: 'default',
    workdir,
    ...overrides
  }
}

function makeOrchestrator(fake: FakeGrok): Orchestrator {
  const agent = makeAgent(fake.bin)
  return new Orchestrator(
    (agentId) => agentId === agent.id ? agent : undefined,
    new SessionStore(fake.storePath)
  )
}

async function readLog(fake: FakeGrok): Promise<JsonRecord[]> {
  try {
    return (await readFile(fake.logPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 4_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15))
  }
  throw new Error(`${label} was not observed within ${timeoutMs}ms`)
}

async function waitForSession(
  orchestrator: Orchestrator,
  sessionId: string,
  predicate: (session: Session | undefined) => boolean,
  label: string
): Promise<Session> {
  return (await waitFor(
    () => orchestrator.getSessionById(sessionId),
    predicate,
    label
  ))!
}

async function waitForEvent(
  orchestrator: Orchestrator,
  sessionId: string,
  predicate: (event: UAEvent) => boolean,
  label: string
): Promise<UAEvent> {
  return (await waitFor(
    async () => (await orchestrator.getEvents(sessionId)).find(predicate),
    (event) => !!event,
    label
  ))!
}

// Break caught: a Grok definition falls through to the generic one-shot runner,
// losing ACP streaming, native identity, and its session-scoped contract.
async function routeAndPersistContract(): Promise<void> {
  const fake = await createFakeGrok()
  const orchestrator = makeOrchestrator(fake)
  const nativeCapabilityChanges: Array<{ agentId: string; workdir: string }> = []
  orchestrator.on('nativeCapabilitiesChanged', (change) => nativeCapabilityChanges.push(change))
  try {
    const session = orchestrator.createSession(makeConfig(fake.workdir), 'stream')
    const settled = await waitForSession(
      orchestrator,
      session.id,
      (value) => value?.status === 'idle' && !!value.nativeSessionId && !!value.agentContract,
      'Grok ACP session contract'
    )
    assert.equal(settled.nativeSessionId, 'grok-session-1')
    assert.equal(settled.agentContract?.currentModelId, 'grok-4.6')
    assert.equal(settled.agentContract?.imageAttachments, false)
    assert.equal(settled.agentContract?.fileAttachments, true)
    assert.equal(settled.agentContract?.sessionList, true)
    assert.equal(settled.agentContract?.sessionLoad, true)
    assert.equal(settled.agentContract?.sessionResume, true)
    assert.equal(settled.agentContract?.sessionFork, false)
    assert.deepEqual(settled.agentContract?.commands, ['compact', 'review'])
    assert.deepEqual(settled.agentContract?.collaborationModes, ['default', 'plan'])
    assert.deepEqual(
      settled.agentContract?.permissionModes.map((mode) => mode.id),
      ['ask', 'full-access']
    )

    const log = await readLog(fake)
    assert.ok(log.some((entry) => entry.kind === 'inbound' && entry.frame?.method === 'initialize'))
    assert.ok(log.some((entry) => entry.kind === 'inbound' && entry.frame?.method === 'session/prompt'))
    assert.equal(log.some((entry) => entry.kind === 'argv' && entry.argv?.length === 1), false)

    const persisted = JSON.parse(await readFile(fake.storePath, 'utf8'))
      .find((entry: JsonRecord) => entry.id === session.id)
    assert.equal(persisted.nativeSessionId, 'grok-session-1')
    assert.equal(persisted.agentContract.currentModelId, 'grok-4.6')
    assert.deepEqual(persisted.agentContract.commands, ['compact', 'review'])
    assert.deepEqual(persisted.agentContract.collaborationModes, ['default', 'plan'])
    assert.ok(
      nativeCapabilityChanges.some((change) =>
        change.agentId === 'grok' && change.workdir === fake.workdir
      ),
      'a negotiated Grok command update must refresh the active slash palette'
    )
  } finally {
    orchestrator.disposeAll()
    await fake.cleanup()
  }
}

// Break caught: Grok Plan is rejected as an app-server-only mode or coupled to
// permission flags instead of being sent through session/set_mode.
async function planAndConfigContract(): Promise<void> {
  const fake = await createFakeGrok()
  const orchestrator = makeOrchestrator(fake)
  try {
    const session = orchestrator.createSession(
      makeConfig(fake.workdir, { collaborationMode: 'plan' }),
      'stream'
    )
    await waitForSession(orchestrator, session.id, (value) => value?.status === 'idle', 'initial Plan turn')
    assert.ok((await readLog(fake)).some((entry) =>
      entry.kind === 'inbound' &&
      entry.frame?.method === 'session/set_mode' &&
      entry.frame?.params?.modeId === 'plan'
    ))

    await orchestrator.setCollaborationMode(session.id, 'default')
    assert.equal(orchestrator.getSessionById(session.id)?.config.collaborationMode, 'default')
    await assert.rejects(orchestrator.updateSessionConfig(session.id, { permissionMode:'read-only' }), /权限|unsupported/)
    await orchestrator.updateSessionConfig(session.id, { permissionMode:'full-access' })
    assert.equal(orchestrator.getSessionById(session.id)?.config.permissionMode, 'full-access')
    await orchestrator.sendMessage(session.id, 'stream')
    await waitForSession(orchestrator, session.id, (value) => value?.status === 'idle', 'updated Grok turn')

    const invocations = (await readLog(fake))
      .filter((entry) => entry.kind === 'argv')
      .map((entry) => entry.argv)
    assert.ok(invocations.every(argv => JSON.stringify(argv) === JSON.stringify(['--no-auto-update','agent','--no-leader','stdio'])))
  } finally {
    orchestrator.disposeAll()
    await fake.cleanup()
  }
}

// Break caught: reverse requests bypass the existing approval state machine, or
// an active Grok turn steers instead of preserving UniAgent's FIFO queue.
async function approvalQuestionAndFifoContract(): Promise<void> {
  const fake = await createFakeGrok()
  const orchestrator = makeOrchestrator(fake)
  try {
    const session = orchestrator.createSession(makeConfig(fake.workdir), 'permission')
    const approval = await waitForEvent(
      orchestrator, session.id,
      (event) => event.type === 'approval_request' && event.state === 'pending',
      'Grok permission request'
    )
    assert.equal(orchestrator.getSessionById(session.id)?.status, 'awaiting-approval')

    await orchestrator.sendMessage(session.id, 'stream')
    assert.deepEqual(orchestrator.getQueue(session.id).map((item) => item.prompt), ['stream'])
    assert.deepEqual(orchestrator.respondToRequest(session.id, approval.payload.requestId, {
      outcome: { outcome: 'selected', optionId: 'allow_once' }
    }), { handled: true, hasPendingRequests: false })

    await waitForSession(orchestrator, session.id, (value) => value?.status === 'idle', 'Grok FIFO completion')
    assert.equal(orchestrator.getQueue(session.id).length, 0)
  } finally {
    orchestrator.disposeAll()
    await fake.cleanup()
  }
}

// Break caught: Stop does not reach the owned Grok ACP runner, leaving the turn
// or a locally queued follow-up alive.
async function interruptContract(): Promise<void> {
  const fake = await createFakeGrok()
  const orchestrator = makeOrchestrator(fake)
  try {
    const session = orchestrator.createSession(makeConfig(fake.workdir), 'wait')
    await waitFor(
      async () => (await readLog(fake)).some((entry) =>
        entry.kind === 'inbound' && entry.frame?.method === 'session/prompt'
      ),
      Boolean,
      'blocking Grok prompt'
    )
    await orchestrator.sendMessage(session.id, 'stream')
    assert.equal(orchestrator.getQueue(session.id).length, 1)
    orchestrator.interrupt(session.id)
    await waitForSession(orchestrator, session.id, (value) => value?.status === 'idle', 'Grok interrupt')
    assert.equal(orchestrator.getQueue(session.id).length, 0)
    assert.ok((await readLog(fake)).some((entry) =>
      entry.kind === 'inbound' && entry.frame?.method === 'session/cancel'
    ))
  } finally {
    orchestrator.disposeAll()
    await fake.cleanup()
  }
}

// Break caught: Grok child output is looked up in Codex rollout files instead
// of the live Grok runner's child-session cache.
async function subagentDetailContract(): Promise<void> {
  const fake = await createFakeGrok()
  const orchestrator = makeOrchestrator(fake)
  try {
    const session = orchestrator.createSession(makeConfig(fake.workdir), 'subagent')
    const settled = await waitForSession(
      orchestrator, session.id,
      (value) => value?.status === 'idle' && value.subagents?.[0]?.status === 'completed',
      'Grok subagent completion'
    )
    assert.equal(settled.subagents?.[0]?.agentThreadId, 'session-child')
    const child = await orchestrator.getSubAgentItems(session.id, 'session-child')
    assert.equal(child.find((event) => event.type === 'reasoning')?.payload.text, 'Child inspecting')
    assert.equal(child.find((event) => event.type === 'agent_message')?.payload.text, 'Child result')
  } finally {
    orchestrator.disposeAll()
    await fake.cleanup()
  }
}

// Break caught: permanent deletion removes UniAgent state before Grok confirms
// native deletion, making a CLI failure irreversible from the desktop UI.
async function nativeFirstDeletionContract(): Promise<void> {
  const succeeding = await createFakeGrok()
  const succeedingOrchestrator = makeOrchestrator(succeeding)
  try {
    const session = succeedingOrchestrator.createSession(makeConfig(succeeding.workdir), 'stream')
    await waitForSession(succeedingOrchestrator, session.id, (value) => value?.status === 'idle', 'native-delete Grok session')
    const nativeId = succeedingOrchestrator.getSessionById(session.id)?.nativeSessionId
    await succeedingOrchestrator.deleteSession(session.id)
    assert.equal(succeedingOrchestrator.getSessionById(session.id), undefined)
    assert.equal(JSON.parse(await readFile(succeeding.statePath, 'utf8')).sessions.some(
      (entry: JsonRecord) => entry.sessionId === nativeId
    ), true, 'native history stays intact when ACP delete is not declared')
    const log = await readLog(succeeding)
    assert.equal(log.some(entry => entry.kind === 'argv' && entry.argv?.[0] === 'sessions'), false)
  } finally {
    succeedingOrchestrator.disposeAll()
    await succeeding.cleanup()
  }
}

await routeAndPersistContract()
await planAndConfigContract()
await approvalQuestionAndFifoContract()
await interruptContract()

await nativeFirstDeletionContract()

console.log('grok-orchestrator: ACP routing and lifecycle contracts ok')
