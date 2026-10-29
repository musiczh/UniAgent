import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppServerRpc } from '../src/main/appServerTransport.ts'
import * as appServerAdapter from '../src/main/appServerAdapter.ts'
import { AppServerRunner } from '../src/main/appServerAdapter.ts'
import { handoffMcpArgs, uniAgentSessionInstructions } from '../src/main/handoff.ts'
import { buildDurableQueueItem, Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import * as nativeContracts from '../src/shared/nativeCapabilities.ts'
import type {
  GoalState,
  NativeGoalAction,
  NativeReviewDraft,
  NativeThreadAction
} from '../src/shared/nativeCapabilities.ts'
import type {
  AgentDef,
  Attachment,
  ResolvedNativeTurnContext,
  Session,
  SessionConfig,
  UAEvent
} from '../src/shared/types.ts'

const baseConfig: SessionConfig = {
  agentId: 'codex',
  workdir: '/repo',
  permissionMode: 'read-only'
}

const testAgent: AgentDef = {
  id: 'codex',
  name: 'Codex',
  bin: '/usr/bin/true',
  adapter: 'codex',
  icon: '',
  builtin: true,
  capabilities: {
    modelSelect: true,
    reasoningEffort: true,
    streaming: true,
    steer: true,
    nativeGoal: true,
    nativeReview: true,
    permissionModes: [
      { id: 'read-only', label: '只读', hint: '' },
      { id: 'ask', label: '请求批准', hint: '' }
    ]
  },
  models: [],
  installed: true
}

const initialGoal: GoalState = {
  objective: '完成原生能力接入',
  status: 'active',
  tokenBudget: 12000,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1
}

class RecordingTransport extends EventEmitter implements AppServerRpc {
  requests: Array<{ method: string; params: any }> = []
  notifications: Array<{ method: string; params: any }> = []
  responses: Array<{ id: number | string; result: any }> = []
  goal: GoalState | undefined
  disposeCalls = 0
  disposed = false
  failSet = false
  failSettings = false
  failReview = false
  startedThreadId = 'thread-1'
  turnId = 'turn-1'
  reviewThreadId = 'thread-1'
  reviewTurnId: string | undefined = 'review-1'
  reviewStartWait?: Promise<void>
  beforeReviewResponseNotifications: Array<{ method: string; params: any }> = []
  requestWaits = new Map<string, Promise<void>>()
  beforeMethodResponseNotifications = new Map<
    string,
    Array<{ method: string; params: any }>
  >()
  planPreset: any = {
    name: 'Plan',
    mode: 'plan',
    model: 'provider-plan-model',
    reasoning_effort: 'high'
  }
  threadModel: string | undefined = 'negotiated-thread-model'
  afterResponseNotification?: { method: string; params: any }
  get workflowRequests() { return this.requests.filter(({ method }) => method !== 'config/read') }
  private wireSequence = 0

  async start(): Promise<void> {}
  notify(method: string, params: any): void {
    this.notifications.push({ method, params })
  }
  respond(id: number | string, result: any): void {
    this.responses.push({ id, result })
  }
  interrupt(): void {}
  async dispose(): Promise<void> {
    this.disposeCalls += 1
    this.disposed = true
  }

  async request<T>(method: string, params: any): Promise<T> {
    return (await this.requestSequenced<T>(method, params)).result
  }

  async requestSequenced<T>(method: string, params: any): Promise<{ result: T; sequence: number }> {
    const responseSequence = ++this.wireSequence
    this.requests.push({ method, params })
    const wait = this.requestWaits.get(method)
    if (wait) await wait
    for (const notification of this.beforeMethodResponseNotifications.get(method) || []) {
      this.emit('notification', notification.method, notification.params, ++this.wireSequence)
    }
    if (method === 'initialize') return { result: {} as T, sequence: responseSequence }
    if (method === 'config/read') return { result: { config: {} } as T, sequence: responseSequence }
    if (method === 'thread/start') {
      return {
        result: { thread: { id: this.startedThreadId, ...(this.threadModel ? { model: this.threadModel } : {}) } } as T,
        sequence: responseSequence
      }
    }
    if (method === 'thread/resume') {
      return {
        result: { thread: { id: params.threadId, ...(this.threadModel ? { model: this.threadModel } : {}) } } as T,
        sequence: responseSequence
      }
    }
    if (method === 'thread/goal/set') {
      if (this.failSet) throw new Error('provider rejected goal')
      this.goal = {
        ...initialGoal,
        objective: params.objective,
        tokenBudget: params.tokenBudget ?? null
      }
      const response = { goal: { threadId: params.threadId, ignored: 'provider-only', ...this.goal } } as T
      this.emitAfterResponseNotification()
      return { result: response, sequence: responseSequence }
    }
    if (method === 'thread/goal/get') {
      const response = { goal: this.goal ?? null } as T
      this.emitAfterResponseNotification()
      return { result: response, sequence: responseSequence }
    }
    if (method === 'thread/goal/clear') {
      this.goal = undefined
      const response = { cleared: true } as T
      this.emitAfterResponseNotification()
      return { result: response, sequence: responseSequence }
    }
    if (method === 'collaborationMode/list') {
      return { result: { data: this.planPreset ? [this.planPreset] : [] } as T, sequence: responseSequence }
    }
    if (method === 'thread/settings/update') {
      if (this.failSettings) throw new Error('provider rejected collaboration mode')
      return { result: {} as T, sequence: responseSequence }
    }
    if (method === 'mode/change/respond') {
      return { result: {} as T, sequence: responseSequence }
    }
    if (method === 'turn/start') {
      return { result: { turn: { id: this.turnId } } as T, sequence: responseSequence }
    }
    if (method === 'review/start') {
      if (this.reviewStartWait) await this.reviewStartWait
      if (this.failReview) throw new Error('provider rejected review')
      for (const notification of this.beforeReviewResponseNotifications.splice(0)) {
        this.emit('notification', notification.method, notification.params, ++this.wireSequence)
      }
      const response = {
        turn: this.reviewTurnId === undefined ? {} : { id: this.reviewTurnId },
        reviewThreadId: this.reviewThreadId
      } as T
      this.emitAfterResponseNotification()
      return { result: response, sequence: responseSequence }
    }
    throw new Error(`unexpected method: ${method}`)
  }

  private emitAfterResponseNotification(): void {
    const notification = this.afterResponseNotification
    this.afterResponseNotification = undefined
    if (notification) {
      this.emit('notification', notification.method, notification.params, ++this.wireSequence)
    }
  }
}

function appServerAgent(id: string, adapter: 'codex' | 'traex', permissionMode = 'ask'): {
  agent: AgentDef
  config: SessionConfig
} {
  return {
    agent: {
      ...testAgent,
      id,
      name: adapter === 'codex' ? 'Codex' : 'TraeX',
      adapter,
      capabilities: {
        ...testAgent.capabilities,
        permissionModes: [
          { id: 'read-only', label: '只读', hint: '' },
          { id: 'ask', label: '请求批准', hint: '' }
        ]
      }
    },
    config: {
      agentId: id,
      workdir: '/repo',
      permissionMode: permissionMode as SessionConfig['permissionMode'],
      collaborationMode: 'plan',
      model: 'configured-model'
    }
  }
}

async function planCollaborationRpcOrdering(): Promise<void> {
  for (const adapter of ['codex', 'traex'] as const) {
    for (const resume of [false, true]) {
      const { agent, config } = appServerAgent(`custom-${adapter}`, adapter)
      config.roleSnapshot = {
        id: 'plan-role', name: 'Plan role', agentId: agent.id,
        permissionMode: 'ask', instructions: 'Preserve the project-specific planning requirements.'
      }
      const transport = new RecordingTransport()
      const runner = new AppServerRunner(
        `session-${adapter}-${resume}`,
        { n: 0 },
        agent,
        config,
        resume ? 'thread-existing' : undefined,
        undefined,
        () => transport
      )
      try {
        await runner.startTurn('只规划，不修改')
        assert.deepEqual(transport.workflowRequests.map(({ method }) => method), [
          'initialize',
          resume ? 'thread/resume' : 'thread/start',
          'thread/goal/get',
          'collaborationMode/list',
          'thread/settings/update',
          'turn/start'
        ])
        assert.deepEqual(transport.requests.slice(0, adapter === 'codex' ? 2 : 1).map(({ method }) => method),
          adapter === 'codex' ? ['initialize', 'config/read'] : ['initialize'])
        const threadRequest = transport.workflowRequests[1]
        assert.equal(threadRequest.params.approvalPolicy, 'on-request')
        assert.equal(threadRequest.params.sandbox, 'workspace-write')
        assert.equal(threadRequest.params.developerInstructions,
          `${uniAgentSessionInstructions()}\n\n${config.roleSnapshot.instructions}`,
          'new and resumed threads must retain business instructions independently of mode instructions')
        assert.deepEqual(transport.workflowRequests[4]?.params, {
          threadId: resume ? 'thread-existing' : 'thread-1',
          collaborationMode: {
            mode: 'plan',
            settings: {
              model: 'provider-plan-model',
              reasoning_effort: 'high',
              developer_instructions: null
            }
          }
        })
        assert.equal(config.permissionMode, 'ask', 'Plan activation must not rewrite permissions')
      } finally {
        runner.dispose()
      }
    }
  }

  for (const adapter of ['codex', 'traex'] as const) {
    const { agent: toggleAgent, config: planConfig } = appServerAgent(`toggle-${adapter}`, adapter)
    const config = { ...planConfig, collaborationMode: 'default' as const }
    const transport = new RecordingTransport()
    const events: UAEvent[] = []
    const changes: string[] = []
    const runner = new AppServerRunner(
      `toggle-${adapter}`,
      { n: 0 },
      toggleAgent,
      config,
      undefined,
      undefined,
      () => transport
    )
    runner.on('event', (event) => events.push(event))
    runner.on('collaborationModeChanged', (mode) => changes.push(mode))
    try {
      await runner.ensureThreadReady()
      await runner.setCollaborationMode('plan')
      await runner.setCollaborationMode('default')
      assert.deepEqual(transport.requests.slice(-3).map(({ method }) => method), [
        'collaborationMode/list', 'thread/settings/update', 'thread/settings/update'
      ])
      assert.deepEqual(transport.requests.at(-1)?.params, {
        threadId: 'thread-1',
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'configured-model',
            reasoning_effort: null,
            developer_instructions: null
          }
        }
      }, `${adapter} must select the explicit Default preset instead of clearing the override`)
      assert.equal(config.permissionMode, 'ask')

      const threadSettings = (mode: unknown): any => ({
        cwd: '/provider/worktree',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' },
        activePermissionProfile: null,
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        serviceTier: 'priority',
        effort: 'high',
        summary: 'auto',
        collaborationMode: mode,
        multiAgentMode: 'explicitRequestOnly',
        personality: null
      })
      transport.emit('notification', 'thread/settings/updated', {
        threadId: 'other-thread',
        threadSettings: threadSettings({ mode: 'plan', settings: { model: 'provider-plan-model' } })
      }, 100)
      transport.emit('notification', 'thread/settings/updated', {
        threadId: 'thread-1',
        threadSettings: threadSettings({
          mode: 'plan',
          settings: { model: 'provider-plan-model', reasoning_effort: 'high' }
        })
      }, 101)
      transport.emit('notification', 'thread/settings/updated', {
        threadId: 'thread-1',
        threadSettings: threadSettings({ mode: 'default', settings: {} })
      }, 102)
      transport.emit('notification', 'thread/settings/updated', {
        threadId: 'thread-1',
        threadSettings: threadSettings({ mode: 'plan', settings: { model: 'stale' } })
      }, 99)
      assert.deepEqual(
        changes,
        ['plan', 'default'],
        'thread scope and wire sequence must guard official collaboration snapshots'
      )
      assert.equal(config.permissionMode, 'ask', 'settings notifications must not mutate permission fields')
      transport.emit('notification', 'thread/settings/updated', {
        threadId: 'thread-1',
        threadSettings: threadSettings({ mode: 'unsafe-provider-mode', settings: {} })
      }, 103)
      assert.match(
        String(events.find(({ type, payload }) => type === 'system_notice' && /无法安全识别/.test(payload?.text))?.payload?.text),
        /无法安全识别/
      )
      assert.deepEqual(changes, ['plan', 'default'])
      assert.equal(config.permissionMode, 'ask')
    } finally {
      runner.dispose()
    }
  }

  const { agent, config } = appServerAgent('custom-codex', 'codex')
  const transport = new RecordingTransport()
  transport.planPreset = null
  const events: UAEvent[] = []
  const runner = new AppServerRunner('missing-plan', { n: 0 }, agent, config, undefined, undefined, () => transport)
  runner.on('event', (event) => events.push(event))
  try {
    await runner.startTurn('must not start')
    assert.equal(transport.requests.some(({ method }) => method === 'turn/start'), false)
    assert.match(String(events.find(({ type }) => type === 'error')?.payload?.message), /未提供 Plan collaboration mode/)
    await runner.startTurn('retry must not bypass Plan')
    assert.equal(
      transport.requests.some(({ method }) => method === 'turn/start'),
      false,
      'a failed Plan handshake must not leave the runner falsely ready for a later turn'
    )
  } finally {
    runner.dispose()
  }

  const missingModelTransport = new RecordingTransport()
  missingModelTransport.planPreset = { name: 'Plan', mode: 'plan', model: null, reasoning_effort: null }
  missingModelTransport.threadModel = undefined
  const missingModelEvents: UAEvent[] = []
  const runnerWithoutModel = new AppServerRunner(
    'missing-plan-model',
    { n: 0 },
    agent,
    { ...config, model: undefined },
    undefined,
    undefined,
    () => missingModelTransport
  )
  runnerWithoutModel.on('event', (event) => missingModelEvents.push(event))
  try {
    await runnerWithoutModel.startTurn('must not start either')
    assert.equal(missingModelTransport.requests.some(({ method }) => method === 'turn/start'), false)
    assert.match(String(missingModelEvents.find(({ type }) => type === 'error')?.payload?.message), /缺少 model/)
  } finally {
    runnerWithoutModel.dispose()
  }

  const exitTransport = new RecordingTransport()
  exitTransport.planPreset = null
  const exitingRunner = new AppServerRunner(
    'exit-stale-plan',
    { n: 0 },
    agent,
    config,
    'thread-existing',
    undefined,
    () => exitTransport
  )
  try {
    await exitingRunner.setCollaborationMode('default')
    assert.deepEqual(exitTransport.workflowRequests.map(({ method }) => method), [
      'initialize', 'thread/resume', 'thread/goal/get', 'thread/settings/update'
    ], 'exiting a persisted Plan session must not depend on fetching a Plan preset first')
    assert.deepEqual(exitTransport.requests.at(-1)?.params, {
      threadId: 'thread-existing',
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'configured-model',
          reasoning_effort: null,
          developer_instructions: null
        }
      }
    })
  } finally {
    exitingRunner.dispose()
  }
}

async function coldCollaborationFailureInvalidatesConnection(): Promise<void> {
  for (const mode of ['default', 'plan'] as const) {
    const { agent, config } = appServerAgent(`cold-failure-${mode}`, 'codex')
    const transports: RecordingTransport[] = []
    const runner = new AppServerRunner(
      `cold-failure-${mode}`,
      { n: 0 },
      agent,
      config,
      'thread-existing',
      undefined,
      () => {
        const transport = new RecordingTransport()
        transport.failSettings = true
        transports.push(transport)
        return transport
      }
    )
    try {
      await assert.rejects(runner.setCollaborationMode(mode), /provider rejected collaboration mode/)
      assert.equal(transports.length, 1)
      assert.deepEqual(transports[0]?.workflowRequests.map(({ method }) => method), [
        'initialize',
        'thread/resume',
        'thread/goal/get',
        ...(mode === 'plan' ? ['collaborationMode/list'] : []),
        'thread/settings/update'
      ])
      assert.equal(transports[0]?.disposeCalls, 1, 'a failed cold settings RPC must dispose its ready transport')
      assert.equal((runner as any).threadId, 'thread-existing', 'failure must preserve the resumable thread id')

      await runner.startTurn('must stay blocked behind Plan renegotiation')
      assert.equal(transports.length, 2, 'the next turn must establish a fresh connection')
      assert.deepEqual(transports[1]?.workflowRequests.map(({ method }) => method), [
        'initialize',
        'thread/resume',
        'thread/goal/get',
        'collaborationMode/list',
        'thread/settings/update'
      ])
      assert.equal(transports[1]?.workflowRequests[1]?.params.threadId, 'thread-existing')
      assert.equal(
        transports.flatMap(({ requests }) => requests).some(({ method }) => method === 'turn/start'),
        false,
        'a second settings failure must continue blocking the turn'
      )
    } finally {
      runner.dispose()
    }
  }

  for (const mode of ['default', 'plan'] as const) {
    const { agent, config } = appServerAgent(`cold-success-${mode}`, 'traex')
    const transports: RecordingTransport[] = []
    const runner = new AppServerRunner(
      `cold-success-${mode}`,
      { n: 0 },
      agent,
      config,
      'thread-existing',
      undefined,
      () => {
        const transport = new RecordingTransport()
        transports.push(transport)
        return transport
      }
    )
    try {
      await runner.setCollaborationMode(mode)
      await runner.startTurn('successful mode update keeps the ready transport')
      assert.equal(transports.length, 1)
      assert.equal(transports[0]?.disposeCalls, 0)
      assert.deepEqual(transports[0]?.workflowRequests.map(({ method }) => method), [
        'initialize',
        'thread/resume',
        'thread/goal/get',
        ...(mode === 'plan' ? ['collaborationMode/list'] : []),
        'thread/settings/update',
        'turn/start'
      ])
      assert.equal(transports[0]?.requests.at(-1)?.method, 'turn/start')
    } finally {
      runner.dispose()
    }
  }
}

async function securityConfigChangesReconnectReadyThreads(): Promise<void> {
  const { agent, config: planConfig } = appServerAgent('security-reconnect', 'codex')
  agent.capabilities.permissionModes.push({ id: 'full-access', label: '完全访问', hint: '' })
  const config: SessionConfig = { ...planConfig, permissionMode: 'full-access' }
  const transports: RecordingTransport[] = []
  const transportCwds: string[] = []
  const runner = new AppServerRunner(
    'security-reconnect-session',
    { n: 0 },
    agent,
    config,
    undefined,
    undefined,
    (options) => {
      transportCwds.push(options.cwd)
      const transport = new RecordingTransport()
      transports.push(transport)
      return transport
    }
  )
  const complete = (): void => {
    ;(runner as any).onNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' }
    })
  }
  try {
    await runner.startTurn('full access')
    complete()
    assert.equal(transports.length, 1)
    assert.deepEqual(transports[0]?.workflowRequests[1], {
      method: 'thread/start',
      params: {
        cwd: '/repo',
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        developerInstructions: uniAgentSessionInstructions(),
        model: 'configured-model',
        modelProvider: 'openai',
        config: Object.fromEntries(handoffMcpArgs('codex', 'security-reconnect-session').filter(arg => arg !== '-c').map(arg => {
          const separator = arg.indexOf('=')
          return [arg.slice(0, separator), JSON.parse(arg.slice(separator + 1))]
        }))
      }
    })

    runner.updateConfig({ ...config, permissionMode: 'read-only' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(transports[0]?.disposeCalls, 1, 'permission changes must retire the ready transport')
    await runner.startTurn('read only')
    complete()
    assert.equal(transports.length, 2)
    assert.deepEqual(transports[1]?.workflowRequests.map(({ method }) => method), [
      'initialize',
      'thread/resume',
      'thread/goal/get',
      'collaborationMode/list',
      'thread/settings/update',
      'turn/start'
    ])
    assert.deepEqual(transports[1]?.workflowRequests[1]?.params, {
      threadId: 'thread-1',
      excludeTurns: true,
      cwd: '/repo',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      developerInstructions: uniAgentSessionInstructions(),
      approvalsReviewer: 'user',
      model: 'configured-model',
      modelProvider: 'openai',
      config: transports[0]?.workflowRequests[1]?.params.config
    })

    const readOnlyConfig: SessionConfig = { ...config, permissionMode: 'read-only' }
    runner.updateConfig({ ...readOnlyConfig, workdir: '/repo-next' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(transports[1]?.disposeCalls, 1, 'workdir changes must retire the ready transport')
    await runner.startTurn('new cwd')
    complete()
    assert.equal(transports.length, 3)
    assert.equal(transportCwds[2], '/repo-next')
    assert.equal(transports[2]?.workflowRequests[1]?.method, 'thread/resume')
    assert.equal(transports[2]?.workflowRequests[1]?.params.cwd, '/repo-next')

    runner.updateConfig({
      ...readOnlyConfig,
      workdir: '/repo-next',
      model: 'next-model',
      effort: 'high',
      fastMode: true,
      maxMode: true
    })
    await runner.startTurn('turn-only config')
    complete()
    assert.equal(transports.length, 3, 'turn-only config changes must keep the ready transport')
    assert.equal(transports[2]?.disposeCalls, 0)
    assert.equal(transports[2]?.requests.at(-1)?.method, 'turn/start')

    await runner.setCollaborationMode('default')
    assert.equal(transports.length, 3)
    assert.equal(transports[2]?.disposeCalls, 0, 'a successful dedicated mode update must stay ready')
  } finally {
    runner.dispose()
  }
}

function recordingRunner(resumeThreadId?: string): {
  runner: AppServerRunner
  transport: RecordingTransport
} {
  const transport = new RecordingTransport()
  return {
    runner: new AppServerRunner(
      'session-1',
      { n: 0 },
      testAgent,
      baseConfig,
      resumeThreadId,
      undefined,
      () => transport
    ),
    transport
  }
}

function recordingRunnerSequence(
  transports: RecordingTransport[],
  resumeThreadId?: string,
  config: SessionConfig = baseConfig,
  agent: AgentDef = testAgent
): AppServerRunner {
  let next = 0
  return new AppServerRunner(
    'session-1',
    { n: 0 },
    agent,
    config,
    resumeThreadId,
    undefined,
    () => {
      const transport = transports[next++]
      if (!transport) throw new Error('recording transport sequence exhausted')
      return transport
    }
  )
}

async function queueWaitMetadataSurvivesStatusReplacement(): Promise<void> {
  const { agent, config } = appServerAgent('queue-wait-metadata', 'traex')
  config.collaborationMode = 'default'
  const transport = new RecordingTransport()
  transport.beforeMethodResponseNotifications.set('turn/start', [
    { method: 'queue/status', params: { state: 'waiting', position: 2 } },
    { method: 'queue/status', params: { state: 'ready' } },
    { method: 'queue/status', params: { state: 'waiting', position: 1 } }
  ])
  const runner = new AppServerRunner(
    'queue-wait-metadata',
    { n: 0 },
    agent,
    config,
    undefined,
    undefined,
    () => transport
  )
  const events: UAEvent[] = []
  runner.on('event', (event) => events.push(event))
  try {
    await runner.startTurn('wait for compute')
    transport.emit('notification', 'item/started', {
      threadId: 'thread-1',
      item: { id: 'queue-progress', type: 'agentMessage', text: '' }
    })
    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' }
    })
    const queueEvents = events.filter(({ type }) => type === 'queue_status')
    assert.equal(queueEvents.length, 4, 'turn/start must close an active final wait phase')
    assert.match(
      String(queueEvents[0]?.payload.id),
      /^queue-turn-attempt-\d+-[0-9a-f-]{36}$/,
      'pre-start queue events must remain unique after the runner is recreated'
    )
    assert.equal(
      new Set(queueEvents.map(({ payload }) => payload.id)).size,
      1,
      'all wait phases in one turn must replace one stable queue event'
    )
    assert.equal(
      queueEvents.filter(({ state }) => state === 'running').every(({ payload }) =>
        Number.isFinite(payload.queue?.startedAt) && Number.isFinite(payload.queue?.waitedMs)
      ),
      true,
      'every active phase must carry a stable start and the accumulated completed duration'
    )
    const completed = queueEvents.at(-1)
    assert.equal(completed?.state, 'success')
    assert.equal(completed?.payload.queue?.state, 'ready')
    assert.equal(completed?.payload.queue?.acquired, true, 'real agent progress confirms compute acquisition')
    assert.equal(Number.isFinite(completed?.payload.queue?.waitedMs), true)
    assert.equal(
      events.findIndex((event) => event === completed) <
        events.findIndex(({ type, payload }) =>
          type === 'agent_message' && payload?.id === 'queue-progress'
        ),
      true,
      'the completed wait must be recorded before real turn progress'
    )
  } finally {
    runner.dispose()
  }
}

async function queueWaitCompletionRequiresCompute(): Promise<void> {
  for (const terminal of ['completed', 'interrupted', 'failed', 'disconnect']) {
    const { agent, config } = appServerAgent(`queue-${terminal}`, 'traex')
    config.collaborationMode = 'default'
    const transport = new RecordingTransport()
    const runner = new AppServerRunner('queue-terminal', { n: 0 }, agent, config, 'thread-1', undefined, () => transport)
    const events: UAEvent[] = []
    runner.on('event', (event) => events.push(event))
    try {
      await runner.startTurn('queue terminal fixture')
      transport.emit('notification', 'queue/status', { threadId: 'thread-1', state: 'waiting', position: 600 })
      transport.emit('notification', 'item/started', {
        threadId: 'thread-1', turnId: 'turn-1', item: { id: 'input', type: 'userMessage', content: [] }
      })
      transport.emit('notification', 'item/agentMessage/delta', {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'empty', delta: ''
      })
      transport.emit('notification', 'turn/completed', {
        threadId: 'thread-1', turn: { id: 'old-turn', status: 'completed' }
      })
      assert.equal(events.filter((event) => event.type === 'queue_status').length, 1,
        'user input and stale terminal events cannot close an active compute wait')
      if (terminal === 'disconnect') transport.emit('disconnect', 'queue fixture connection closed')
      else transport.emit('notification', 'turn/completed', {
        threadId: 'thread-1', turn: { id: 'turn-1', status: terminal }
      })
      const queueEvents = events.filter((event) => event.type === 'queue_status')
      assert.equal(queueEvents.length, 2, 'every terminal path must close the wait once')
      assert.equal(queueEvents[1].payload.queue.acquired, terminal === 'completed',
        'cancelled, failed and disconnected turns must never train successful queue history')
      if (terminal !== 'completed') {
        assert.equal(queueEvents[1].payload.queue.endReason,
          terminal === 'disconnect' ? 'disconnected' : terminal === 'interrupted' ? 'cancelled' : 'failed',
          'quality logs must preserve the terminal reason')
      }
    } finally {
      runner.dispose()
    }
  }
}

async function interruptedQueueWaitIgnoresLateNotifications(): Promise<void> {
  const { agent, config } = appServerAgent('queue-interrupt', 'traex')
  config.collaborationMode = 'default'
  const transport = new RecordingTransport()
  const runner = new AppServerRunner('queue-interrupt', { n: 0 }, agent, config, 'thread-1', undefined, () => transport)
  const events: UAEvent[] = []
  runner.on('event', (event) => events.push(event))
  try {
    await runner.startTurn('interrupt queued turn')
    transport.emit('notification', 'queue/status', {
      threadId: 'thread-1', turnId: 'turn-1', state: 'waiting', position: 10
    })
    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' }
    })

    const settledCount = events.filter(({ type }) => type === 'queue_status').length
    transport.emit('notification', 'queue/status', {
      threadId: 'thread-1', turnId: 'turn-1', state: 'waiting', position: 9
    })
    assert.equal(
      events.filter(({ type }) => type === 'queue_status').length,
      settledCount,
      'a queue heartbeat arriving after interrupt must not revive the completed wait'
    )

    const nextTurnGate = deferred<void>()
    transport.requestWaits.set('turn/start', nextTurnGate.promise)
    transport.turnId = 'turn-2'
    const nextTurn = runner.startTurn('next turn')
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(
        transport.requests.filter(({ method }) => method === 'turn/start').length,
        2,
        'the next turn must be waiting for its turn/start response'
      )
      transport.emit('notification', 'queue/status', {
        threadId: 'thread-1', turnId: 'turn-1', state: 'waiting', position: 8
      })
      assert.equal(
        events.filter(({ type }) => type === 'queue_status').length,
        settledCount,
        'a stale queue heartbeat must not attach while the next turn is starting'
      )
    } finally {
      nextTurnGate.resolve(undefined)
      await nextTurn
    }
  } finally {
    runner.dispose()
  }
}

async function reviewStartupPreservesQueueReceivedAt(): Promise<void> {
  const { agent, config } = appServerAgent('review-queue-wait', 'traex')
  config.collaborationMode = 'default'
  const transport = new RecordingTransport()
  transport.beforeReviewResponseNotifications.push(
    {
      method: 'queue/status',
      params: { threadId: 'thread-1', turnId: 'old-turn', state: 'waiting' }
    },
    {
      method: 'queue/status',
      params: { threadId: 'thread-1', turnId: 'review-1', state: 'waiting' }
    },
    {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'review-1', status: 'completed' }
      }
    }
  )
  const runner = new AppServerRunner(
    'review-queue-wait',
    { n: 0 },
    agent,
    config,
    undefined,
    undefined,
    () => transport
  )
  const events: UAEvent[] = []
  runner.on('event', (event) => events.push(event))
  const originalNow = Date.now
  let now = 1_000
  const advanceAfterCurrentWaitStarts = (method: string, params: any): void => {
    if (method === 'queue/status' && params?.turnId === 'review-1') now = 6_000
  }
  try {
    await runner.ensureThreadReady()
    Date.now = () => now
    transport.on('notification', advanceAfterCurrentWaitStarts)
    await runner.startReview({ scope: { type: 'uncommittedChanges' } })

    const queueEvents = events.filter(({ type }) => type === 'queue_status')
    assert.equal(queueEvents.length, 2, 'stale review-start notifications must be filtered by turn id')
    assert.equal(queueEvents[0]?.payload.queue?.startedAt, 1_000)
    assert.equal(queueEvents[0]?.ts, 1_000, 'buffer replay must preserve each observation receive time for history')
    assert.equal(
      queueEvents[1]?.payload.queue?.waitedMs,
      5_000,
      'buffer replay must close the wait at turn/completed receive time, not RPC response time'
    )
  } finally {
    transport.off('notification', advanceAfterCurrentWaitStarts)
    Date.now = originalNow
    runner.dispose()
  }
}

async function abortedReviewIgnoresScopedStaleQueueWait(): Promise<void> {
  const { agent, config } = appServerAgent('aborted-review-queue-wait', 'traex')
  config.collaborationMode = 'default'
  const transport = new RecordingTransport()
  transport.reviewTurnId = undefined
  transport.beforeReviewResponseNotifications.push(
    {
      method: 'queue/status',
      params: { threadId: 'thread-1', turnId: 'old-turn', state: 'waiting' }
    },
    {
      method: 'queue/status',
      params: { threadId: 'thread-1', state: 'waiting' }
    }
  )
  const runner = new AppServerRunner(
    'aborted-review-queue-wait',
    { n: 0 },
    agent,
    config,
    undefined,
    undefined,
    () => transport
  )
  const events: UAEvent[] = []
  runner.on('event', (event) => events.push(event))
  const originalNow = Date.now
  let now = 1_000
  const advanceAfterUnscopedWaitStarts = (method: string, params: any): void => {
    if (method === 'queue/status' && params?.turnId === undefined) now = 6_000
  }
  try {
    await runner.ensureThreadReady()
    Date.now = () => now
    transport.on('notification', advanceAfterUnscopedWaitStarts)
    await assert.rejects(
      runner.startReview({ scope: { type: 'uncommittedChanges' } }),
      /review\/start 未返回 turn id/
    )

    const queueEvents = events.filter(({ type }) => type === 'queue_status')
    assert.equal(queueEvents.length, 2, 'aborted review must ignore explicitly scoped stale waits')
    assert.equal(queueEvents[0]?.payload.queue?.startedAt, 1_000)
    assert.equal(queueEvents[1]?.payload.queue?.waitedMs, 5_000)
    assert.equal(queueEvents[1]?.payload.queue?.acquired, false, 'an aborted review is not successful queue history')
  } finally {
    transport.off('notification', advanceAfterUnscopedWaitStarts)
    Date.now = originalNow
    runner.dispose()
  }
}

async function goalRpcAndNotifications(): Promise<void> {
  const { runner, transport } = recordingRunner()
  const api = runner as AppServerRunner & {
    ensureThreadReady(): Promise<string>
    getGoal(): Promise<GoalState | undefined>
    setGoal(input: { objective: string; tokenBudget?: number }): Promise<GoalState>
    clearGoal(): Promise<void>
  }
  const changes: Array<GoalState | undefined> = []
  const events: UAEvent[] = []
  runner.on('goalChanged', (goal) => changes.push(goal))
  runner.on('event', (event) => events.push(event))
  try {
    assert.equal(await api.ensureThreadReady(), 'thread-1')
    assert.deepEqual(
      transport.requests.slice(-2).map(({ method }) => method),
      ['thread/start', 'thread/goal/get'],
      'thread creation must reconcile Goal directly without self-waiting through public getGoal'
    )
    assert.equal(changes.at(-1), undefined, 'an empty provider snapshot must clear stale state')

    const set = await api.setGoal({ objective: '  完成原生能力接入  ', tokenBudget: 12000 })
    assert.deepEqual(transport.requests.at(-1), {
      method: 'thread/goal/set',
      params: {
        threadId: 'thread-1',
        objective: '完成原生能力接入',
        status: 'active',
        tokenBudget: 12000
      }
    })
    assert.deepEqual(set, initialGoal)
    assert.deepEqual(changes.at(-1), initialGoal)
    assert.equal(
      events.some((event) => event.type === 'system_notice' && event.payload?.kind !== 'launch'),
      false,
      'Goal state must not be translated into an ordinary chat notice'
    )

    assert.deepEqual(await api.getGoal(), initialGoal)
    assert.equal(transport.requests.at(-1)?.method, 'thread/goal/get')

    transport.failSet = true
    const confirmedBeforeFailure = changes.at(-1)
    await assert.rejects(
      api.setGoal({ objective: 'provider must confirm this' }),
      /provider rejected goal/
    )
    assert.equal(changes.at(-1), confirmedBeforeFailure)
    assert.equal(transport.requests.some(({ method }) => method === 'thread/delete'), false)
    transport.failSet = false

    transport.emit('notification', 'thread/goal/updated', {
      threadId: 'other-thread',
      goal: { ...initialGoal, objective: 'child pollution', updatedAt: 2 }
    })
    assert.equal(changes.at(-1)?.objective, initialGoal.objective)
    transport.emit('notification', 'thread/goal/updated', {
      threadId: 'thread-1',
      turnId: null,
      goal: { ...initialGoal, tokensUsed: '8', timeUsedSeconds: '2', updatedAt: '2' }
    })
    assert.equal(changes.at(-1)?.tokensUsed, 8)
    assert.equal(changes.at(-1)?.timeUsedSeconds, 2)
    assert.equal(changes.at(-1)?.updatedAt, 2)

    transport.emit('notification', 'thread/goal/cleared', { threadId: 'other-thread' })
    assert.ok(changes.at(-1))
    transport.emit('notification', 'thread/goal/cleared', { threadId: 'thread-1' })
    assert.equal(changes.at(-1), undefined)

    await api.clearGoal()
    assert.deepEqual(transport.requests.at(-1), {
      method: 'thread/goal/clear',
      params: { threadId: 'thread-1' }
    })
    assert.equal(changes.at(-1), undefined)
    assert.equal(transport.requests.some(({ method }) => method === 'turn/start'), false)
  } finally {
    runner.dispose()
  }
}

async function providerCompletionSettlesGoalTurnOnce(): Promise<void> {
  const { runner, transport } = recordingRunner()
  const events: UAEvent[] = []
  const done: unknown[] = []
  runner.on('event', (event) => events.push(event))
  runner.on('done', (payload) => done.push(payload))
  try {
    await runner.startTurn('完成 Goal')
    transport.emit('notification', 'thread/tokenUsage/updated', {
      threadId: 'thread-1',
      tokenUsage: {
        last: { inputTokens: 8, outputTokens: 2 },
        total: { inputTokens: 8, outputTokens: 2 }
      }
    })

    transport.emit('notification', 'thread/goal/updated', {
      threadId: 'thread-1',
      goal: { ...initialGoal, status: 'complete', timeUsedSeconds: 2 }
    })
    assert.equal(
      events.filter((event) => event.type === 'turn_completed').length,
      0,
      'Goal metadata completion must not fabricate a turn boundary'
    )
    assert.equal(done.length, 0)

    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', durationMs: 2_000 }
    })

    const usage = events.find(
      (event) => event.type === 'system_notice' && event.payload?.kind === 'usage'
    )
    assert.equal(usage?.payload.durationMs, 2_000)
    assert.equal(usage?.payload.usage?.inputTokens, 8)
    assert.equal(usage?.payload.usage?.outputTokens, 2)
    assert.equal(events.filter((event) => event.type === 'turn_completed').length, 1)
    assert.equal(done.length, 1)

    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', durationMs: 2_500 }
    })
    assert.equal(
      events.filter((event) => event.type === 'turn_completed').length,
      1,
      'a delayed provider completion must not duplicate the Goal terminal boundary'
    )
  } finally {
    runner.dispose()
  }
}

async function goalWireSequenceOrdering(): Promise<void> {
  const { runner, transport } = recordingRunner()
  const api = runner as AppServerRunner & {
    ensureThreadReady(): Promise<string>
    getGoal(): Promise<GoalState | undefined>
    setGoal(input: { objective: string; tokenBudget?: number }): Promise<GoalState>
    clearGoal(): Promise<void>
  }
  const changes: Array<GoalState | undefined> = []
  runner.on('goalChanged', (goal) => changes.push(goal))
  try {
    transport.goal = { ...initialGoal, objective: 'reconcile response', updatedAt: 1 }
    transport.afterResponseNotification = {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        goal: { ...initialGoal, objective: 'reconcile notification', updatedAt: 2 }
      }
    }
    await api.ensureThreadReady()
    assert.equal(
      changes.at(-1)?.objective,
      'reconcile notification',
      'a later notification in the response chunk must win over reconcile response continuation'
    )

    transport.afterResponseNotification = {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        goal: { ...initialGoal, objective: 'set notification', updatedAt: 4 }
      }
    }
    await api.setGoal({ objective: 'set response' })
    assert.equal(
      changes.at(-1)?.objective,
      'set notification',
      'a later notification must not be overwritten by an older set response'
    )

    transport.goal = { ...initialGoal, objective: 'get response', updatedAt: 5 }
    transport.afterResponseNotification = {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        goal: { ...initialGoal, objective: 'get notification', updatedAt: 6 }
      }
    }
    assert.equal(
      (await api.getGoal())?.objective,
      'get notification',
      'getGoal must return the newest wire-ordered snapshot'
    )

    transport.afterResponseNotification = {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        goal: { ...initialGoal, objective: 'clear notification', updatedAt: 7 }
      }
    }
    await api.clearGoal()
    assert.equal(
      changes.at(-1)?.objective,
      'clear notification',
      'a clear response must not erase a later notification without a Goal revision'
    )
  } finally {
    runner.dispose()
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function storedSession(goal?: GoalState): Session {
  return {
    id: 'goal-session',
    title: 'Goal session',
    config: baseConfig,
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    nativeSessionId: 'thread-1',
    origin: 'created',
    ...(goal ? { goal } : {})
  }
}

async function sessionStoreGoalRoundTrip(): Promise<void> {
  const path = join(tmpdir(), `uniagent-native-goal-${process.pid}-${Date.now()}.json`)
  const store = new SessionStore(path)
  try {
    store.saveOrThrow([storedSession({ ...initialGoal, providerSecret: 'drop-me' } as GoalState)])
    assert.deepEqual(store.load()[0]?.goal, initialGoal)

    const raw = JSON.parse(await readFile(path, 'utf8'))
    raw[0].goal = { ...initialGoal, status: 'forged', providerSecret: 'drop-me' }
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, JSON.stringify(raw)))
    assert.equal(store.load()[0]?.goal, undefined, 'malformed Goal must be omitted without dropping its session')
  } finally {
    await rm(path, { force: true })
  }
}

async function sessionPlanMigrationAndRoundTrip(): Promise<void> {
  const path = join(tmpdir(), `uniagent-session-plan-${process.pid}-${Date.now()}.json`)
  const contract = {
    models: [],
    permissionModes: [
      { id: 'plan', label: '计划模式', hint: 'legacy' },
      { id: 'ask', label: '请求批准', hint: '' }
    ],
    currentPermissionMode: 'plan',
    imageAttachments: true,
    fileAttachments: true,
    sessionList: true,
    sessionLoad: true,
    sessionResume: true,
    sessionFork: true,
    commands: []
  }
  const row = (id: string, agentId: string): Session => ({
    id,
    title: id,
    config: { agentId, workdir: '/repo', permissionMode: 'plan' },
    status: 'idle',
    createdAt: 1,
    agentContract: contract as any
  })
  await writeFile(path, JSON.stringify([
    row('codex-plan', 'custom-codex'),
    row('traex-plan', 'custom-traex'),
    row('claude-plan', 'custom-claude'),
    row('unknown-plan', 'unknown'),
    {
      ...row('inconsistent-contract', 'custom-codex'),
      agentContract: { ...contract, permissionModes: [contract.permissionModes[1]] }
    }
  ]))
  const agents = new Map<string, AgentDef>([
    ['custom-codex', appServerAgent('custom-codex', 'codex').agent],
    ['custom-traex', appServerAgent('custom-traex', 'traex').agent],
    ['custom-claude', {
      ...testAgent,
      id: 'custom-claude',
      adapter: 'claude',
      capabilities: {
        ...testAgent.capabilities,
        streaming: false,
        permissionModes: [{ id: 'plan', label: '计划模式', hint: '' }]
      }
    }]
  ])
  class CountingSessionStore extends SessionStore {
    saves = 0
    override save(sessions: Session[]): void {
      this.saves += 1
      super.save(sessions)
    }
  }
  const store = new CountingSessionStore(path)
  const orchestrator = new Orchestrator((id) => agents.get(id), store)
  const updates: string[] = []
  orchestrator.on('sessionUpdated', (payload: any) => updates.push(payload?.session?.id || payload?.id))
  try {
    orchestrator.loadPersisted()
    const migrate = (orchestrator as any).migrateLegacyPlanSessions
    assert.equal(typeof migrate, 'function', 'startup needs an explicit migration after agent adapters are known')
    assert.equal(migrate.call(orchestrator), true)
    assert.equal(store.saves, 1, 'all migrated sessions must persist in one write')
    assert.deepEqual(updates.sort(), ['codex-plan', 'inconsistent-contract', 'traex-plan'])
    assert.equal(migrate.call(orchestrator), false)
    assert.equal(store.saves, 1, 'the migration must be idempotent')

    for (const id of ['codex-plan', 'traex-plan']) {
      const migrated = orchestrator.getSessionById(id)!
      assert.equal(migrated.config.permissionMode, 'read-only')
      assert.equal(migrated.config.collaborationMode, 'plan')
      assert.deepEqual(migrated.agentContract?.permissionModes.map(({ id: mode }) => mode), ['read-only', 'ask'])
      assert.equal(migrated.agentContract?.currentPermissionMode, 'read-only')
    }
    const claude = orchestrator.getSessionById('claude-plan')!
    assert.equal(claude.config.permissionMode, 'plan')
    assert.equal(claude.config.collaborationMode, undefined)
    assert.equal(claude.agentContract?.currentPermissionMode, 'plan')
    const unknown = orchestrator.getSessionById('unknown-plan')!
    assert.equal(unknown.config.permissionMode, 'plan')
    assert.equal(unknown.config.collaborationMode, undefined)
    const inconsistent = orchestrator.getSessionById('inconsistent-contract')!
    assert.deepEqual(inconsistent.agentContract?.permissionModes.map(({ id }) => id), ['ask'])
    assert.equal(
      inconsistent.agentContract?.currentPermissionMode,
      undefined,
      'an inconsistent legacy current Plan must be cleared instead of inventing a permission inventory'
    )

    const persisted = new SessionStore(path).load()
    assert.equal(persisted.find(({ id }) => id === 'codex-plan')?.config.collaborationMode, 'plan')
    const roundTrip = { ...persisted[0]!, config: { ...persisted[0]!.config, collaborationMode: 'default' as const } }
    store.saveOrThrow([roundTrip])
    assert.equal(store.load()[0]?.config.collaborationMode, 'default')
  } finally {
    orchestrator.disposeAll()
    await rm(path, { force: true })
  }
}

async function planRequiresAppServerTransport(): Promise<void> {
  const originalStartTurn = AppServerRunner.prototype.startTurn
  const appServerTurns: string[] = []
  AppServerRunner.prototype.startTurn = async function (prompt: string): Promise<void> {
    appServerTurns.push(prompt)
  }
  try {
    for (const adapter of ['codex', 'traex'] as const) {
      const path = join(tmpdir(), `uniagent-plan-no-stream-${adapter}-${process.pid}-${Date.now()}.json`)
      const id = `one-shot-${adapter}`
      const { agent } = appServerAgent(id, adapter)
      agent.capabilities.streaming = false
      const claude: AgentDef = {
        ...testAgent,
        id: `one-shot-claude-${adapter}`,
        adapter: 'claude',
        capabilities: {
          ...testAgent.capabilities,
          streaming: false,
          permissionModes: [{ id: 'plan', label: '计划模式', hint: '' }]
        }
      }
      const agents = new Map<string, AgentDef>([[id, agent], [claude.id, claude]])
      const store = new SessionStore(path)
      store.saveOrThrow([{
        id: `legacy-${adapter}`,
        title: `legacy-${adapter}`,
        config: { agentId: id, workdir: '/repo', permissionMode: 'plan' },
        status: 'idle',
        createdAt: 1
      }])
      const orchestrator = new Orchestrator((agentId) => agents.get(agentId), store)
      const oneShotTurns: string[] = []
      ;(orchestrator as any).runOneShot = (_session: Session, _agent: AgentDef, prompt: string): void => {
        oneShotTurns.push(prompt)
      }
      try {
        orchestrator.loadPersisted()
        assert.equal((orchestrator as any).migrateLegacyPlanSessions(), true)
        const legacy = orchestrator.getSessionById(`legacy-${adapter}`)!
        assert.equal(legacy.config.permissionMode, 'read-only')
        assert.equal(legacy.config.collaborationMode, 'plan')

        const beforeEventCount = (await orchestrator.getEvents(legacy.id)).length
        const activityBeforeSend = (orchestrator as any).sessionActivityGeneration(legacy.id)
        await assert.rejects(
          orchestrator.sendMessage(legacy.id, 'must not become a hidden one-shot'),
          /plan_collaboration_requires_app_server/
        )
        assert.equal((await orchestrator.getEvents(legacy.id)).length, beforeEventCount)
        assert.equal((orchestrator as any).sessionActivityGeneration(legacy.id), activityBeforeSend)
        assert.equal(legacy.status, 'idle')
        assert.deepEqual(oneShotTurns, [])
        assert.equal((orchestrator as any).runners.size, 0)
        assert.equal((orchestrator as any).streamers.size, 0)
        assert.equal((orchestrator as any).pendingSends.has(legacy.id), false)
        assert.equal((orchestrator as any).sendTails.has(legacy.id), false)

        agent.capabilities.streaming = true
        await orchestrator.sendMessage(legacy.id, 'retry through app-server')
        assert.equal(appServerTurns.at(-1), 'retry through app-server')
        assert.equal(
          (await orchestrator.getEvents(legacy.id)).filter(({ type }) => type === 'user_message').length,
          1,
          'the rejected send must remain retryable without duplicating its user event'
        )

        agent.capabilities.streaming = false
        const idsBeforeCreate = orchestrator.listSessions().map(({ id: sessionId }) => sessionId).sort()
        const streamersBeforeCreate = (orchestrator as any).streamers.size
        const appServerTurnsBeforeCreate = appServerTurns.length
        assert.throws(
          () => orchestrator.createSession({
            agentId: id,
            workdir: '/repo',
            permissionMode: 'read-only',
            collaborationMode: 'plan'
          }, 'new Plan must fail before creating state'),
          /plan_collaboration_requires_app_server/
        )
        assert.deepEqual(orchestrator.listSessions().map(({ id: sessionId }) => sessionId).sort(), idsBeforeCreate)
        assert.deepEqual(oneShotTurns, [])
        assert.equal((orchestrator as any).runners.size, 0)
        assert.equal((orchestrator as any).streamers.size, streamersBeforeCreate)
        assert.equal(appServerTurns.length, appServerTurnsBeforeCreate)

        agent.capabilities.streaming = true
        const created = orchestrator.createSession({
          agentId: id,
          workdir: '/repo',
          permissionMode: 'read-only',
          collaborationMode: 'plan'
        }, 'new Plan retry')
        assert.equal(created.config.collaborationMode, 'plan')
        assert.equal(appServerTurns.at(-1), 'new Plan retry')

        agent.capabilities.streaming = false
        const ordinary = orchestrator.createSession({
          agentId: id,
          workdir: '/repo',
          permissionMode: 'read-only'
        }, 'ordinary one-shot')
        const claudePlan = orchestrator.createSession({
          agentId: claude.id,
          workdir: '/repo',
          permissionMode: 'plan'
        }, 'Claude permission Plan')
        assert.equal(ordinary.config.collaborationMode, undefined)
        assert.equal(claudePlan.config.permissionMode, 'plan')
        assert.deepEqual(oneShotTurns, ['ordinary one-shot', 'Claude permission Plan'])
      } finally {
        orchestrator.disposeAll()
        await rm(path, { force: true })
      }
    }
  } finally {
    AppServerRunner.prototype.startTurn = originalStartTurn
  }
}

async function nonStreamingPlanFinalGuardsAreSideEffectFree(): Promise<void> {
  const originalStartTurn = AppServerRunner.prototype.startTurn
  const appServerTurns: string[] = []
  AppServerRunner.prototype.startTurn = async function (prompt: string): Promise<void> {
    appServerTurns.push(prompt)
  }
  try {
    for (const adapter of ['codex', 'traex'] as const) {
      const path = join(tmpdir(), `uniagent-plan-final-guard-${adapter}-${process.pid}-${Date.now()}.json`)
      const id = `guard-${adapter}`
      const { agent } = appServerAgent(id, adapter)
      const makeSession = (suffix: string): Session => ({
        id: `${suffix}-${adapter}`,
        title: `${suffix}-${adapter}`,
        config: {
          agentId: id,
          workdir: '/repo',
          permissionMode: 'read-only',
          collaborationMode: 'plan'
        },
        status: 'idle',
        createdAt: 1,
        origin: 'created'
      })
      const direct = makeSession('direct-run')
      const reentrant = makeSession('reentrant-send')
      const scheduled = {
        ...makeSession('scheduled-queue'),
        nativeSessionId: `thread-${adapter}`,
        pendingQueue: [{
          id: `queue-${adapter}`,
          prompt: `scheduled retry ${adapter}`,
          acceptedAt: 1,
          state: 'pending' as const,
          attempts: 0
        }]
      }
      const store = new SessionStore(path)
      store.saveOrThrow([direct, reentrant, scheduled])
      const orchestrator = new Orchestrator((agentId) => agentId === id ? agent : undefined, store)
      const oneShotTurns: string[] = []
      ;(orchestrator as any).runOneShot = (_session: Session, _agent: AgentDef, prompt: string): void => {
        oneShotTurns.push(prompt)
      }
      try {
        orchestrator.loadPersisted()
        const directOwner = orchestrator.getSessionById(direct.id)!
        const reentrantOwner = orchestrator.getSessionById(reentrant.id)!
        const scheduledOwner = orchestrator.getSessionById(scheduled.id)!

        agent.capabilities.streaming = false
        const directQueueBefore = structuredClone(orchestrator.getQueue(direct.id))
        const directStarted = (orchestrator as any).run(directOwner, `direct guard ${adapter}`)
        const directObserved = {
          started: directStarted,
          status: directOwner.status,
          eventTypes: ((orchestrator as any).events.get(direct.id) as UAEvent[]).map(({ type }) => type),
          queue: orchestrator.getQueue(direct.id),
          runners: (orchestrator as any).runners.size,
          streamers: (orchestrator as any).streamers.size
        }

        agent.capabilities.streaming = true
        const flipStreamingDuringRecord = (event: UAEvent): void => {
          if (event.sessionId === reentrant.id && event.type === 'user_message') {
            agent.capabilities.streaming = false
          }
        }
        orchestrator.on('event', flipStreamingDuringRecord)
        await orchestrator.sendMessage(reentrant.id, `reentrant ${adapter}`)
        orchestrator.off('event', flipStreamingDuringRecord)
        const reentrantEvents = (orchestrator as any).events.get(reentrant.id) as UAEvent[]
        const reentrantObserved = {
          status: reentrantOwner.status,
          userMessages: reentrantEvents.filter(({ type }) => type === 'user_message').length,
          errors: reentrantEvents.filter(({ type }) => type === 'error').length,
          appServerTurns: appServerTurns.filter((prompt) => prompt === `reentrant ${adapter}`).length,
          oneShotTurns: oneShotTurns.filter((prompt) => prompt === `reentrant ${adapter}`).length
        }

        agent.capabilities.streaming = true
        const scheduledEventsBefore = ((orchestrator as any).events.get(scheduled.id) as UAEvent[]).length
        const scheduledQueueBefore = structuredClone(orchestrator.getQueue(scheduled.id))
        ;(orchestrator as any).afterTurn(scheduledOwner)
        agent.capabilities.streaming = false
        await new Promise<void>((resolve) => setImmediate(resolve))
        const scheduledBlockedObserved = {
          status: scheduledOwner.status,
          events: ((orchestrator as any).events.get(scheduled.id) as UAEvent[]).length,
          queue: orchestrator.getQueue(scheduled.id),
          runners: (orchestrator as any).runners.size,
          streamers: (orchestrator as any).streamers.has(scheduled.id)
        }

        agent.capabilities.streaming = true
        ;(orchestrator as any).getEvents = async (sessionId: string): Promise<UAEvent[]> => (
          (orchestrator as any).events.get(sessionId) || []
        )
        orchestrator.resumePendingQueues(new Set([id]))
        const retryTail = (orchestrator as any).sendTails.get(scheduled.id) as Promise<void> | undefined
        assert.ok(retryTail, 'restored streaming support must make the unchanged queue retryable')
        await retryTail
        const scheduledEvents = (orchestrator as any).events.get(scheduled.id) as UAEvent[]
        const scheduledRetryObserved = {
          userMessages: scheduledEvents.filter(({ type }) => type === 'user_message').length,
          promptCount: scheduledEvents.filter(
            ({ type, payload }) => type === 'user_message' && payload?.text === `scheduled retry ${adapter}`
          ).length,
          appServerTurns: appServerTurns.filter((prompt) => prompt === `scheduled retry ${adapter}`).length,
          queue: orchestrator.getQueue(scheduled.id).map(({ state, attempts }) => ({ state, attempts }))
        }

        assert.deepEqual({
          direct: directObserved,
          reentrant: reentrantObserved,
          scheduledBlocked: scheduledBlockedObserved,
          scheduledRetry: scheduledRetryObserved
        }, {
          direct: {
            started: false,
            status: 'idle',
            eventTypes: [],
            queue: directQueueBefore,
            runners: 0,
            streamers: 0
          },
          reentrant: {
            status: 'running',
            userMessages: 1,
            errors: 0,
            appServerTurns: 1,
            oneShotTurns: 0
          },
          scheduledBlocked: {
            status: 'idle',
            events: scheduledEventsBefore,
            queue: scheduledQueueBefore,
            runners: 0,
            streamers: false
          },
          scheduledRetry: {
            userMessages: 1,
            promptCount: 1,
            appServerTurns: 1,
            queue: [{ state: 'dispatching', attempts: 1 }]
          }
        })
      } finally {
        orchestrator.disposeAll()
        await rm(path, { force: true })
      }
    }
  } finally {
    AppServerRunner.prototype.startTurn = originalStartTurn
  }
}

async function preparedPlanRouteRevalidatesCurrentAgent(): Promise<void> {
  const originalStartTurn = AppServerRunner.prototype.startTurn
  const starts: Array<{ prompt: string; bin: string; version?: string }> = []
  AppServerRunner.prototype.startTurn = async function (prompt: string): Promise<void> {
    starts.push({
      prompt,
      bin: (this as any).agent.bin,
      version: (this as any).agent.version
    })
  }
  const scenarios: Array<{
    name: string
    mutate: (state: {
      current: AgentDef
      replace: (agent: AgentDef) => void
      session: Session
    }) => void
    accepted: boolean
    expectedBin?: string
    expectedVersion?: string
    seedStreamer?: boolean
    expectReusedOldStreamer?: boolean
  }> = [
    {
      name: 'replacement-unavailable',
      mutate: ({ current, replace }) => replace({
        ...current,
        installed: false,
        lifecycle: {
          availability: 'unhealthy',
          auth: 'authenticated',
          health: 'unhealthy'
        }
      }),
      accepted: false
    },
    {
      name: 'replacement-invalid-adapter',
      mutate: ({ current, replace }) => replace({
        ...current,
        adapter: 'generic',
        capabilities: { ...current.capabilities, streaming: false }
      }),
      accepted: false
    },
    {
      name: 'in-place-permission-revoked',
      mutate: ({ current }) => { current.capabilities.permissionModes = [] },
      accepted: false
    },
    {
      name: 'in-place-invalid-bin',
      mutate: ({ current }) => { current.bin = '' },
      accepted: false
    },
    {
      name: 'invalid-current-config',
      mutate: ({ session }) => {
        session.config = { ...session.config, permissionMode: 'full-access' }
      },
      accepted: false
    },
    {
      name: 'replacement-current-runtime',
      mutate: ({ current, replace }) => replace({
        ...current,
        bin: '/current/codex',
        version: '2.0.0'
      }),
      accepted: true,
      expectedBin: '/current/codex',
      expectedVersion: '2.0.0',
      seedStreamer: true,
      expectReusedOldStreamer: false
    },
    {
      name: 'replacement-current-definition',
      mutate: ({ current, replace }) => replace({
        ...current,
        name: 'Current replacement definition'
      }),
      accepted: true,
      expectedBin: '/usr/bin/true',
      seedStreamer: true,
      expectReusedOldStreamer: true
    }
  ]
  try {
    for (const scenario of scenarios) {
      const path = join(tmpdir(), `uniagent-plan-current-agent-${scenario.name}-${process.pid}-${Date.now()}.json`)
      let currentAgent = appServerAgent(`current-agent-${scenario.name}`, 'codex').agent
      const store = new SessionStore(path)
      store.saveOrThrow([{
        id: `current-session-${scenario.name}`,
        title: scenario.name,
        config: {
          agentId: currentAgent.id,
          workdir: '/repo',
          permissionMode: 'read-only',
          collaborationMode: 'plan'
        },
        status: 'idle',
        createdAt: 1,
        origin: 'created'
      }])
      const orchestrator = new Orchestrator(
        (agentId) => agentId === currentAgent.id ? currentAgent : undefined,
        store
      )
      orchestrator.loadPersisted()
      const session = orchestrator.getSessionById(`current-session-${scenario.name}`)!
      const oldStreamer = scenario.seedStreamer
        ? (orchestrator as any).ensureMainStreamer(session, currentAgent) as AppServerRunner
        : undefined
      const oldTransport = oldStreamer ? new RecordingTransport() : undefined
      if (oldStreamer && oldTransport) {
        ;(oldStreamer as any).transport = oldTransport
        ;(oldStreamer as any).threadId = 'seed-thread'
      }
      const prompt = `current agent ${scenario.name}`
      const mutateBeforeCommit = (candidate: { sessionId: string; prompt: string }): void => {
        if (candidate.sessionId !== session.id || candidate.prompt !== prompt) return
        scenario.mutate({
          current: currentAgent,
          replace: (agent) => { currentAgent = agent },
          session
        })
      }
      orchestrator.on('beforeUserMessageCommit', mutateBeforeCommit)
      let rejection: unknown
      try {
        await orchestrator.sendMessage(session.id, prompt)
      } catch (error) {
        rejection = error
      } finally {
        orchestrator.off('beforeUserMessageCommit', mutateBeforeCommit)
      }
      const events = (orchestrator as any).events.get(session.id) as UAEvent[]
      const streamer = (orchestrator as any).streamers.get(session.id) as AppServerRunner | undefined
      assert.deepEqual({
        accepted: rejection === undefined,
        status: session.status,
        userMessages: events.filter(({ type }) => type === 'user_message').length,
        errors: events.filter(({ type }) => type === 'error').length,
        runners: (orchestrator as any).runners.size,
        streamer: !!streamer,
        reusedOldStreamer: oldStreamer ? streamer === oldStreamer : false,
        streamerUsesCurrentDefinition: streamer
          ? (streamer as any).agent.name === currentAgent.name
          : undefined,
        started: starts.filter(({ prompt: startedPrompt }) => startedPrompt === prompt),
        streamerRuntime: streamer
          ? { bin: (streamer as any).agent.bin, version: (streamer as any).agent.version }
          : undefined
      }, scenario.accepted
        ? {
            accepted: true,
            status: 'running',
            userMessages: 1,
            errors: 0,
            runners: 0,
            streamer: true,
            reusedOldStreamer: scenario.expectReusedOldStreamer === true,
            streamerUsesCurrentDefinition: true,
            started: [{ prompt, bin: scenario.expectedBin, version: scenario.expectedVersion }],
            streamerRuntime: { bin: scenario.expectedBin, version: scenario.expectedVersion }
          }
        : {
            accepted: false,
            status: 'idle',
            userMessages: 0,
            errors: 0,
            runners: 0,
            streamer: false,
            reusedOldStreamer: false,
            streamerUsesCurrentDefinition: undefined,
            started: [],
            streamerRuntime: undefined
          }, scenario.name)
      if (oldStreamer && scenario.expectReusedOldStreamer === false) {
        assert.equal(oldTransport?.disposeCalls, 1, `${scenario.name} must dispose the old runtime`)
        oldStreamer.emit('event', {
          sessionId: session.id,
          seq: 999,
          ts: Date.now(),
          type: 'agent_message',
          payload: { text: 'stale old runner event' }
        } satisfies UAEvent)
        assert.equal(events.some(({ payload }) => payload?.text === 'stale old runner event'), false)
      }
      orchestrator.disposeAll()
      await rm(path, { force: true })
    }

    const createPath = join(tmpdir(), `uniagent-plan-current-create-${process.pid}-${Date.now()}.json`)
    let createAgent = appServerAgent('current-create', 'codex').agent
    const createOrchestrator = new Orchestrator(
      (agentId) => agentId === createAgent.id ? createAgent : undefined,
      new SessionStore(createPath)
    )
    const invalidateCreate = (candidate: { prompt: string }): void => {
      if (candidate.prompt === 'create must reject before publish') {
        createAgent = { ...createAgent, installed: false }
      }
    }
    createOrchestrator.on('beforeUserMessageCommit', invalidateCreate)
    assert.throws(() => createOrchestrator.createSession({
      agentId: createAgent.id,
      workdir: '/repo',
      permissionMode: 'read-only',
      collaborationMode: 'plan'
    }, 'create must reject before publish'), /agent_not_available/)
    assert.equal(createOrchestrator.listSessions().length, 0)
    assert.equal((createOrchestrator as any).streamers.size, 0)
    createOrchestrator.disposeAll()
    await rm(createPath, { force: true })

    const activationPath = join(tmpdir(), `uniagent-plan-current-activation-${process.pid}-${Date.now()}.json`)
    let activationAgent = appServerAgent('current-activation', 'codex').agent
    const activationStore = new SessionStore(activationPath)
    activationStore.saveOrThrow([{
      id: 'activation-current-session',
      title: 'activation',
      config: {
        agentId: activationAgent.id,
        workdir: '/repo',
        permissionMode: 'read-only',
        collaborationMode: 'default'
      },
      status: 'idle',
      createdAt: 1,
      origin: 'created'
    }])
    const activationOrchestrator = new Orchestrator(
      (agentId) => agentId === activationAgent.id ? activationAgent : undefined,
      activationStore
    )
    activationOrchestrator.loadPersisted()
    const originalSetMode = AppServerRunner.prototype.setCollaborationMode
    AppServerRunner.prototype.setCollaborationMode = async function (): Promise<void> {}
    const invalidateActivation = (candidate: { prompt: string }): void => {
      if (candidate.prompt === 'activate must reject before publish') {
        activationAgent.capabilities.permissionModes = []
      }
    }
    activationOrchestrator.on('beforeUserMessageCommit', invalidateActivation)
    try {
      await assert.rejects(
        activationOrchestrator.sendMessage(
          'activation-current-session', 'activate must reject before publish', undefined, undefined, true
        ),
        /permission|permissions|权限模式/
      )
      assert.equal(
        ((activationOrchestrator as any).events.get('activation-current-session') as UAEvent[])
          .filter(({ type }) => type === 'user_message').length,
        0
      )
      assert.equal((activationOrchestrator as any).streamers.size, 0)
      assert.equal(starts.some(({ prompt }) => prompt === 'activate must reject before publish'), false)
    } finally {
      AppServerRunner.prototype.setCollaborationMode = originalSetMode
      activationOrchestrator.disposeAll()
      await rm(activationPath, { force: true })
    }

    const queuePath = join(tmpdir(), `uniagent-plan-current-queue-${process.pid}-${Date.now()}.json`)
    let queueAgent = appServerAgent('current-queue', 'traex').agent
    const queueStore = new SessionStore(queuePath)
    queueStore.saveOrThrow([{
      id: 'queue-current-session',
      title: 'queue',
      config: {
        agentId: queueAgent.id,
        workdir: '/repo',
        permissionMode: 'read-only',
        collaborationMode: 'plan'
      },
      status: 'idle',
      createdAt: 1,
      origin: 'created',
      pendingQueue: [{
        id: 'current-queue-head',
        prompt: 'queue must roll back',
        acceptedAt: 1,
        state: 'pending',
        attempts: 0
      }]
    }])
    const queueOrchestrator = new Orchestrator(
      (agentId) => agentId === queueAgent.id ? queueAgent : undefined,
      queueStore
    )
    queueOrchestrator.loadPersisted()
    const invalidateQueue = (candidate: { prompt: string }): void => {
      if (candidate.prompt === 'queue must roll back') queueAgent = { ...queueAgent, installed: false }
    }
    queueOrchestrator.on('beforeUserMessageCommit', invalidateQueue)
    ;(queueOrchestrator as any).dispatchPendingQueue(
      queueOrchestrator.getSessionById('queue-current-session')!
    )
    assert.deepEqual(queueOrchestrator.getQueue('queue-current-session').map(({ state, attempts }) => ({ state, attempts })), [
      { state: 'pending', attempts: 0 }
    ])
    assert.equal(
      ((queueOrchestrator as any).events.get('queue-current-session') as UAEvent[])
        .filter(({ type }) => type === 'user_message').length,
      0
    )
    assert.equal(queueOrchestrator.getSessionById('queue-current-session')?.status, 'idle')
    assert.equal((queueOrchestrator as any).streamers.size, 0)
    queueOrchestrator.disposeAll()
    await rm(queuePath, { force: true })
  } finally {
    AppServerRunner.prototype.startTurn = originalStartTurn
  }
}

async function userMessageCommitIsAtomicBeforePublicFanout(): Promise<void> {
  const path = join(tmpdir(), `uniagent-plan-precommit-${process.pid}-${Date.now()}.json`)
  const healthy = appServerAgent('precommit-agent', 'codex').agent
  let currentAgent = healthy
  const store = new SessionStore(path)
  store.saveOrThrow([{
    id: 'precommit-session',
    title: 'precommit',
    config: {
      agentId: healthy.id,
      workdir: '/repo',
      permissionMode: 'read-only',
      collaborationMode: 'plan'
    },
    status: 'idle',
    createdAt: 1,
    origin: 'created'
  }])
  const orchestrator = new Orchestrator(
    (agentId) => agentId === currentAgent.id ? currentAgent : undefined,
    store
  )
  orchestrator.loadPersisted()
  const session = orchestrator.getSessionById('precommit-session')!
  const observed: UAEvent[] = []
  const started: string[] = []
  const originalStartTurn = AppServerRunner.prototype.startTurn
  AppServerRunner.prototype.startTurn = async function (prompt: string): Promise<void> {
    started.push(prompt)
  }
  const invalidateBeforeCommit = (candidate: { sessionId: string; prompt: string }): void => {
    if (candidate.sessionId !== session.id || candidate.prompt !== 'atomic retry') return
    currentAgent = { ...healthy, installed: false }
    ;(orchestrator as any).record(session.id, {
      type: 'system_notice',
      payload: { kind: 'notice', text: 'legal precommit sibling' }
    })
  }
  orchestrator.on('event', (event) => observed.push(event))
  orchestrator.on('beforeUserMessageCommit', invalidateBeforeCommit)
  try {
    await assert.rejects(orchestrator.sendMessage(session.id, 'atomic retry'), /agent_not_available/)
    assert.deepEqual(observed.map(({ type, seq, payload }) => ({ type, seq, text: payload?.text })), [{
      type: 'system_notice', seq: 0, text: 'legal precommit sibling'
    }])
    assert.deepEqual(
      ((orchestrator as any).events.get(session.id) as UAEvent[]).map(({ seq }) => seq),
      [0],
      'a failed precommit must retain legal siblings without a sequence gap'
    )
    assert.equal((orchestrator as any).seqRefs.get(session.id).n, 1)
    assert.equal((orchestrator as any).streamers.size, 0)

    orchestrator.off('beforeUserMessageCommit', invalidateBeforeCommit)
    currentAgent = healthy
    const invalidateAfterPublish = (event: UAEvent): void => {
      if (event.type === 'user_message' && event.payload?.text === 'atomic retry') {
        currentAgent = { ...healthy, installed: false }
      }
    }
    orchestrator.on('event', invalidateAfterPublish)
    await orchestrator.sendMessage(session.id, 'atomic retry')
    assert.deepEqual(started, ['atomic retry'])
    assert.equal(observed.filter(({ type }) => type === 'user_message').length, 1)
    assert.deepEqual(
      ((orchestrator as any).events.get(session.id) as UAEvent[]).map(({ seq }) => seq),
      [0, 1]
    )

    ;(orchestrator as any).setStatus(session, 'idle')
    await assert.rejects(orchestrator.sendMessage(session.id, 'next operation'), /agent_not_available/)
    assert.equal(observed.filter(({ type }) => type === 'user_message').length, 1)
  } finally {
    AppServerRunner.prototype.startTurn = originalStartTurn
    orchestrator.disposeAll()
    await rm(path, { force: true })
  }
}

async function queueDispatchCommitPreservesReentrantChanges(): Promise<void> {
  const originalStartTurn = AppServerRunner.prototype.startTurn
  const starts: string[] = []
  AppServerRunner.prototype.startTurn = async function (prompt: string): Promise<void> {
    starts.push(prompt)
  }
  try {
    for (const action of [
      'precommit-enqueue',
      'precommit-stop',
      'enqueue',
      'stop-queue',
      'stop-user'
    ] as const) {
      const path = join(tmpdir(), `uniagent-plan-queue-cas-${action}-${process.pid}-${Date.now()}.json`)
      const { agent } = appServerAgent(`queue-cas-${action}`, 'codex')
      const sessionId = `queue-cas-session-${action}`
      const store = new SessionStore(path)
      store.saveOrThrow([{
        id: sessionId,
        title: action,
        config: {
          agentId: agent.id,
          workdir: '/repo',
          permissionMode: 'read-only',
          collaborationMode: 'plan'
        },
        status: action === 'precommit-enqueue' ? 'running' : 'queued',
        createdAt: 1,
        origin: 'created',
        pendingQueue: [{
          id: `head-${action}`,
          prompt: `head-${action}`,
          acceptedAt: 1,
          state: 'pending',
          attempts: 0
        }]
      }])
      const orchestrator = new Orchestrator((id) => id === agent.id ? agent : undefined, store)
      orchestrator.loadPersisted()
      const session = orchestrator.getSessionById(sessionId)!
      if (action === 'precommit-enqueue') session.status = 'running'
      const queueSnapshots: Array<Array<{ prompt: string; state: string }>> = []
      let acted = false
      let preparedBeforePublish = false
      orchestrator.on('beforeUserMessageCommit', (candidate: { prompt: string }) => {
        if (candidate.prompt !== `head-${action}`) return
        if (action === 'precommit-enqueue') {
          void orchestrator.sendMessage(sessionId, 'listener-added')
        } else if (action === 'precommit-stop') {
          orchestrator.interrupt(sessionId)
        }
      })
      orchestrator.on('queueChange', ({ queue }: { queue: Array<{ prompt: string; state: string }> }) => {
        queueSnapshots.push(queue.map(({ prompt, state }) => ({ prompt, state })))
        if (acted || queue[0]?.prompt !== `head-${action}` || queue[0]?.state !== 'dispatching') return
        acted = true
        preparedBeforePublish = (orchestrator as any).streamers.has(sessionId)
        if (action === 'enqueue') {
          void orchestrator.sendMessage(sessionId, 'listener-added')
        } else if (action === 'stop-queue') {
          orchestrator.interrupt(sessionId)
        }
      })
      if (action === 'stop-user') {
        orchestrator.on('event', (event: UAEvent) => {
          if (event.type === 'user_message' && event.payload?.text === 'head-stop-user') {
            orchestrator.interrupt(sessionId)
          }
        })
      }
      try {
        ;(orchestrator as any).dispatchPendingQueue(session)
        await new Promise<void>((resolve) => setImmediate(resolve))
        const queue = orchestrator.getQueue(sessionId).map(({ prompt, state, attempts }) => ({
          prompt, state, attempts
        }))
        const persisted = JSON.parse(await readFile(path, 'utf8')) as Session[]
        const persistedQueue = persisted[0]?.pendingQueue?.map(({ prompt, state, attempts }) => ({
          prompt, state, attempts
        })) ?? []
        const persistedStatus = persisted[0]?.status
        if (action !== 'precommit-stop') {
          assert.equal(preparedBeforePublish, true, `${action} must observe an already prepared runner`)
        }
        if (action === 'enqueue' || action === 'precommit-enqueue') {
          assert.deepEqual(queue, [
            { prompt: `head-${action}`, state: 'dispatching', attempts: 1 },
            { prompt: 'listener-added', state: 'pending', attempts: 0 }
          ])
          assert.deepEqual(persistedQueue, queue)
          assert.deepEqual(queueSnapshots.at(-1), queue.map(({ prompt, state }) => ({ prompt, state })))
          assert.deepEqual(starts.filter((prompt) => prompt === `head-${action}`), [`head-${action}`])
          assert.equal(session.status, 'queued', 'a synchronous enqueue status change must be retained')
          assert.equal(
            persistedStatus,
            'idle',
            `${action} durable status must use SessionStore's restart-safe normalization`
          )
          assert.equal(
            ((orchestrator as any).events.get(sessionId) as UAEvent[])
              .filter(({ type, payload }) => type === 'user_message' && payload?.text === `head-${action}`).length,
            1
          )
        } else {
          assert.deepEqual(queue, [])
          assert.deepEqual(persistedQueue, [])
          assert.deepEqual(queueSnapshots.at(-1), [])
          assert.equal(starts.includes(`head-${action}`), false)
          assert.equal(session.status, 'idle')
          assert.equal(persistedStatus, 'idle', `${action} durable status`)
          assert.equal(
            queueSnapshots.some((snapshot) => snapshot.some(({ state }) => state === 'pending')),
            false,
            'Stop must never be followed by a revived pending head notification'
          )
        }
      } finally {
        orchestrator.disposeAll()
        await rm(path, { force: true })
      }
    }
  } finally {
    AppServerRunner.prototype.startTurn = originalStartTurn
  }
}

type MutableTurnInput = {
  attachments: Attachment[]
  nativeContext: ResolvedNativeTurnContext
}

function mutableTurnInput(label: string): MutableTurnInput {
  return {
    attachments: [{
      kind: 'image',
      name: `${label}.png`,
      path: `/safe-${label}.png`,
      mime: 'image/png'
    }],
    nativeContext: {
      skills: [{ name: `${label}-skill`, path: `/safe-${label}/SKILL.md` }],
      mcpServers: [{ name: `${label}-mcp` }]
    }
  }
}

function mutateCallerInput(input: MutableTurnInput): void {
  input.attachments[0].path = '/caller-mutated.png'
  input.nativeContext.skills[0].path = '/caller-mutated/SKILL.md'
}

function mutateAuditInput(event: UAEvent): void {
  const attachments = event.payload?.attachments as Attachment[] | undefined
  const nativeContext = event.payload?.nativeContext as ResolvedNativeTurnContext | undefined
  if (attachments?.[0]) {
    attachments[0].path = '/audit-mutated.png'
    attachments.push({ kind: 'file', name: 'audit-added.txt', path: '/audit-added.txt' })
  }
  if (nativeContext?.skills[0]) nativeContext.skills[0].path = '/audit-mutated/SKILL.md'
}

function assertSafeTurnInput(
  actual: { attachments?: Attachment[]; nativeContext?: ResolvedNativeTurnContext } | undefined,
  label: string,
  message: string
): void {
  assert.deepEqual({
    attachments: actual?.attachments,
    nativeContext: actual?.nativeContext
  }, {
    attachments: [{
      kind: 'image',
      name: `${label}.png`,
      path: `/safe-${label}.png`,
      mime: 'image/png'
    }],
    nativeContext: {
      skills: [{ name: `${label}-skill`, path: `/safe-${label}/SKILL.md` }],
      mcpServers: [{ name: `${label}-mcp` }]
    }
  }, message)
}

function assertSafeAttachments(
  attachments: Attachment[] | undefined,
  label: string,
  message: string
): void {
  assert.deepEqual(attachments, [{
    kind: 'image',
    name: `${label}.png`,
    path: `/safe-${label}.png`,
    mime: 'image/png'
  }], message)
}

async function turnInputSnapshotsIsolateProviderAndQueue(): Promise<void> {
  const originalStartTurn = AppServerRunner.prototype.startTurn
  const originalSteer = AppServerRunner.prototype.steer
  const originalSetMode = AppServerRunner.prototype.setCollaborationMode
  const starts: Array<{
    prompt: string
    attachments?: Attachment[]
    nativeContext?: ResolvedNativeTurnContext
  }> = []
  const steers: Array<{
    prompt: string
    attachments?: Attachment[]
    nativeContext?: ResolvedNativeTurnContext
  }> = []
  let appServerSteerRelease: (() => void) | undefined
  AppServerRunner.prototype.startTurn = async function (
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext
  ): Promise<void> {
    starts.push(structuredClone({ prompt, attachments, nativeContext }))
  }
  AppServerRunner.prototype.steer = async function (
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext
  ): Promise<void> {
    if (prompt === 'immutable force appserver') {
      await new Promise<void>((resolve) => { appServerSteerRelease = resolve })
    }
    steers.push(structuredClone({ prompt, attachments, nativeContext }))
  }
  AppServerRunner.prototype.setCollaborationMode = async function (): Promise<void> {}

  const paths: string[] = []
  const orchestrators: Orchestrator[] = []
  const makeStoredOrchestrator = (
    label: string,
    agent: AgentDef,
    config: SessionConfig,
    pendingQueue?: Session['pendingQueue']
  ): { orchestrator: Orchestrator; session: Session; store: SessionStore; path: string } => {
    const path = join(tmpdir(), `uniagent-plan-input-${label}-${process.pid}-${Date.now()}.json`)
    paths.push(path)
    const store = new SessionStore(path)
    const sessionId = `immutable-${label}`
    store.saveOrThrow([{
      id: sessionId,
      title: label,
      config,
      status: pendingQueue ? 'queued' : 'idle',
      createdAt: 1,
      origin: 'created',
      ...(pendingQueue ? { pendingQueue } : {})
    }])
    const orchestrator = new Orchestrator((id) => id === agent.id ? agent : undefined, store)
    orchestrators.push(orchestrator)
    orchestrator.loadPersisted()
    return { orchestrator, session: orchestrator.getSessionById(sessionId)!, store, path }
  }
  const watchAudit = (orchestrator: Orchestrator, prompt: string): void => {
    orchestrator.on('event', (event: UAEvent) => {
      if (event.type === 'user_message' && event.payload?.text === prompt) mutateAuditInput(event)
    })
  }

  try {
    const createAgent = appServerAgent('immutable-create-agent', 'codex').agent
    const createPath = join(tmpdir(), `uniagent-plan-input-create-${process.pid}-${Date.now()}.json`)
    paths.push(createPath)
    const createOrchestrator = new Orchestrator(
      (id) => id === createAgent.id ? createAgent : undefined,
      new SessionStore(createPath)
    )
    orchestrators.push(createOrchestrator)
    const createInput = mutableTurnInput('create')
    watchAudit(createOrchestrator, 'immutable create')
    createOrchestrator.createSession({
      agentId: createAgent.id,
      workdir: '/repo',
      permissionMode: 'read-only',
      collaborationMode: 'plan'
    }, 'immutable create', createInput.attachments, undefined, createInput.nativeContext)
    assertSafeTurnInput(starts.find(({ prompt }) => prompt === 'immutable create'), 'create', 'create provider input')
    assertSafeTurnInput(createInput, 'create', 'create caller input must not share the audit payload')

    const sendAgent = appServerAgent('immutable-send-agent', 'codex').agent
    const sendFixture = makeStoredOrchestrator('send', sendAgent, {
      agentId: sendAgent.id,
      workdir: '/repo',
      permissionMode: 'read-only',
      collaborationMode: 'plan'
    })
    const sendInput = mutableTurnInput('send')
    watchAudit(sendFixture.orchestrator, 'immutable send')
    const sendPromise = sendFixture.orchestrator.sendMessage(
      sendFixture.session.id,
      'immutable send',
      sendInput.attachments,
      sendInput.nativeContext
    )
    mutateCallerInput(sendInput)
    await sendPromise
    assertSafeTurnInput(starts.find(({ prompt }) => prompt === 'immutable send'), 'send', 'send provider input')
    assert.equal(sendInput.attachments.length, 1, 'send audit mutation must not append to caller attachments')
    assert.equal(sendInput.attachments[0].path, '/caller-mutated.png')
    assert.equal(sendInput.nativeContext.skills[0].path, '/caller-mutated/SKILL.md')

    const activationAgent = appServerAgent('immutable-activation-agent', 'traex').agent
    const activationFixture = makeStoredOrchestrator('activation', activationAgent, {
      agentId: activationAgent.id,
      workdir: '/repo',
      permissionMode: 'read-only',
      collaborationMode: 'default'
    })
    const activationInput = mutableTurnInput('activation')
    watchAudit(activationFixture.orchestrator, 'immutable activation')
    const activationPromise = activationFixture.orchestrator.sendMessage(
      activationFixture.session.id,
      'immutable activation',
      activationInput.attachments,
      activationInput.nativeContext,
      true
    )
    mutateCallerInput(activationInput)
    await activationPromise
    assertSafeTurnInput(
      starts.find(({ prompt }) => prompt === 'immutable activation'),
      'activation',
      'activatePlan provider input'
    )
    assert.equal(activationInput.attachments.length, 1)

    const durableSource = mutableTurnInput('durable')
    const durable = buildDurableQueueItem(
      'immutable durable', durableSource.attachments, durableSource.nativeContext, 1
    )
    mutateCallerInput(durableSource)
    assertSafeTurnInput(durable, 'durable', 'durable queue item must own its accepted input')

    const queueInput = mutableTurnInput('queue')
    const queueAgent = appServerAgent('immutable-queue-agent', 'codex').agent
    const queueFixture = makeStoredOrchestrator('queue', queueAgent, {
      agentId: queueAgent.id,
      workdir: '/repo',
      permissionMode: 'read-only',
      collaborationMode: 'plan'
    }, [{
      id: 'immutable-queue-head',
      prompt: 'immutable queue',
      attachments: queueInput.attachments,
      nativeContext: queueInput.nativeContext,
      acceptedAt: 1,
      state: 'pending',
      attempts: 0
    }])
    watchAudit(queueFixture.orchestrator, 'immutable queue')
    queueFixture.orchestrator.on('queueChange', ({ queue }: { queue: Session['pendingQueue'] }) => {
      const head = queue?.[0]
      if (head?.prompt !== 'immutable queue' || head.state !== 'dispatching') return
      if (head.attachments?.[0]) {
        head.attachments[0].path = '/queue-listener-mutated.png'
        head.attachments.push({ kind: 'file', name: 'queue-added.txt', path: '/queue-added.txt' })
      }
      if (head.nativeContext?.skills[0]) {
        head.nativeContext.skills[0].path = '/queue-listener-mutated/SKILL.md'
      }
    })
    ;(queueFixture.orchestrator as any).dispatchPendingQueue(queueFixture.session)
    assertSafeTurnInput(starts.find(({ prompt }) => prompt === 'immutable queue'), 'queue', 'queue provider input')
    assertSafeTurnInput(queueFixture.orchestrator.getQueue(queueFixture.session.id)[0], 'queue', 'live queue input')
    const persistedQueue = new SessionStore(queueFixture.path).load()[0]?.pendingQueue?.[0]
    assertSafeTurnInput(persistedQueue, 'queue', 'durable queue input')

    const forceAgent = appServerAgent('immutable-force-agent', 'codex').agent
    const forceFixture = makeStoredOrchestrator('force-appserver', forceAgent, {
      agentId: forceAgent.id,
      workdir: '/repo',
      permissionMode: 'read-only',
      collaborationMode: 'plan'
    })
    forceFixture.session.status = 'running'
    ;(forceFixture.orchestrator as any).ensureMainStreamer(forceFixture.session, forceAgent)
    const forceInput = mutableTurnInput('force-appserver')
    watchAudit(forceFixture.orchestrator, 'immutable force appserver')
    const forcePromise = forceFixture.orchestrator.forceSend(
      forceFixture.session.id,
      'immutable force appserver',
      forceInput.attachments,
      forceInput.nativeContext
    )
    mutateCallerInput(forceInput)
    assert.ok(appServerSteerRelease)
    appServerSteerRelease!()
    await forcePromise
    assertSafeTurnInput(
      steers.find(({ prompt }) => prompt === 'immutable force appserver'),
      'force-appserver',
      'app-server force steer input'
    )
    assert.equal(forceInput.attachments.length, 1)
  } finally {
    AppServerRunner.prototype.startTurn = originalStartTurn
    AppServerRunner.prototype.steer = originalSteer
    AppServerRunner.prototype.setCollaborationMode = originalSetMode
    for (const orchestrator of orchestrators) orchestrator.disposeAll()
    for (const path of paths) await rm(path, { force: true })
  }
}


async function forceSendPropagatesPlanRejection(): Promise<void> {
  const originalStartTurn = AppServerRunner.prototype.startTurn
  const starts: string[] = []
  AppServerRunner.prototype.startTurn = async function (prompt: string): Promise<void> {
    starts.push(prompt)
  }
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    for (const adapter of ['codex', 'traex'] as const) {
      const path = join(tmpdir(), `uniagent-plan-force-${adapter}-${process.pid}-${Date.now()}.json`)
      const { agent } = appServerAgent(`force-${adapter}`, adapter)
      agent.capabilities.streaming = false
      const store = new SessionStore(path)
      store.saveOrThrow([{
        id: `force-session-${adapter}`,
        title: `force-${adapter}`,
        config: {
          agentId: agent.id,
          workdir: '/repo',
          permissionMode: 'read-only',
          collaborationMode: 'plan'
        },
        status: 'idle',
        createdAt: 1,
        origin: 'created'
      }])
      const orchestrator = new Orchestrator((agentId) => agentId === agent.id ? agent : undefined, store)
      orchestrator.loadPersisted()
      const session = orchestrator.getSessionById(`force-session-${adapter}`)!
      const eventsBefore = ((orchestrator as any).events.get(session.id) as UAEvent[]).length
      const queueBefore = structuredClone(orchestrator.getQueue(session.id))
      const prompt = `force retry ${adapter}`
      const result = orchestrator.forceSend(session.id, prompt)
      let rejection: unknown
      if (result && typeof (result as Promise<void>).then === 'function') {
        try {
          await result
        } catch (error) {
          rejection = error
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual({
        returnedPromise: !!result && typeof (result as Promise<void>).then === 'function',
        rejected: /plan_collaboration_requires_app_server/.test(String((rejection as Error)?.message || rejection)),
        unhandled: unhandled.map((error) => String((error as Error)?.message || error)),
        status: session.status,
        events: ((orchestrator as any).events.get(session.id) as UAEvent[]).length,
        queue: orchestrator.getQueue(session.id),
        runners: (orchestrator as any).runners.size,
        streamers: (orchestrator as any).streamers.size
      }, {
        returnedPromise: true,
        rejected: true,
        unhandled: [],
        status: 'idle',
        events: eventsBefore,
        queue: queueBefore,
        runners: 0,
        streamers: 0
      })

      agent.capabilities.streaming = true
      await orchestrator.forceSend(session.id, prompt)
      assert.equal(starts.filter((value) => value === prompt).length, 1)
      assert.equal(
        ((orchestrator as any).events.get(session.id) as UAEvent[])
          .filter(({ type, payload }) => type === 'user_message' && payload?.text === prompt).length,
        1
      )
      orchestrator.disposeAll()
      await rm(path, { force: true })
    }
  } finally {
    process.off('unhandledRejection', onUnhandled)
    AppServerRunner.prototype.startTurn = originalStartTurn
  }
}

async function orchestratorPlanActivation(): Promise<void> {
  const path = join(tmpdir(), `uniagent-plan-activation-${process.pid}-${Date.now()}.json`)
  const store = new SessionStore(path)
  const { agent } = appServerAgent('custom-codex', 'codex')
  store.saveOrThrow([{
    ...storedSession(),
    id: 'plan-session',
    config: { agentId: agent.id, workdir: '/repo', permissionMode: 'ask', collaborationMode: 'default' }
  }])
  const orchestrator = new Orchestrator((id) => id === agent.id ? agent : undefined, store)
  orchestrator.loadPersisted()
  const originalSetMode = (AppServerRunner.prototype as any).setCollaborationMode
  const originalStartTurn = AppServerRunner.prototype.startTurn
  const calls: string[] = []
  try {
    ;(AppServerRunner.prototype as any).setCollaborationMode = async function (mode: string): Promise<void> {
      calls.push(`settings:${mode}`)
    }
    AppServerRunner.prototype.startTurn = async function (): Promise<void> {
      calls.push('turn:start')
    }
    const session = orchestrator.getSessionById('plan-session')!
    await (orchestrator.sendMessage as any)(session.id, '先规划', undefined, undefined, true)
    assert.deepEqual(calls, ['settings:plan', 'turn:start'])
    assert.equal(session.config.permissionMode, 'ask')
    assert.equal(session.config.collaborationMode, 'plan')
    assert.equal(
      (await orchestrator.getEvents(session.id)).filter(({ type }) => type === 'user_message').length,
      1
    )

    session.status = 'idle'
    await (orchestrator as any).setCollaborationMode(session.id, 'default')
    assert.deepEqual(calls, ['settings:plan', 'turn:start', 'settings:default'])
    assert.equal(session.config.permissionMode, 'ask')
    assert.equal(session.config.collaborationMode, 'default')
    await orchestrator.updateSessionConfig(session.id, { permissionMode: 'read-only' })
    assert.equal(session.config.permissionMode, 'read-only')
    assert.equal(session.config.collaborationMode, 'default')
    await orchestrator.updateSessionConfig(session.id, { permissionMode: 'ask' })
    await assert.rejects(
      orchestrator.updateSessionConfig(session.id, { collaborationMode: 'plan' }),
      /setCollaborationMode/
    )
    assert.equal(session.config.permissionMode, 'ask')
    assert.equal(session.config.collaborationMode, 'default')

    session.status = 'running'
    await assert.rejects(
      (orchestrator.sendMessage as any)(session.id, 'busy Plan', undefined, undefined, true),
      /任务或排队消息/
    )
    session.status = 'idle'
    ;(orchestrator as any).queues.set(session.id, [{ id: 'queued' }])
    await assert.rejects(
      (orchestrator.sendMessage as any)(session.id, 'queued Plan', undefined, undefined, true),
      /任务或排队消息/
    )
    ;(orchestrator as any).queues.set(session.id, [])

    ;(AppServerRunner.prototype as any).setCollaborationMode = async (): Promise<void> => {
      throw new Error('provider rejected collaboration mode')
    }
    const beforeEvents = (await orchestrator.getEvents(session.id)).length
    await assert.rejects(
      (orchestrator.sendMessage as any)(session.id, 'must not record', undefined, undefined, true),
      /provider rejected collaboration mode/
    )
    assert.equal((await orchestrator.getEvents(session.id)).length, beforeEvents)
    assert.equal(session.config.permissionMode, 'ask')
    assert.equal(session.config.collaborationMode, 'default')

    const created = orchestrator.createSession(
      { agentId: agent.id, workdir: '/repo', permissionMode: 'read-only', collaborationMode: 'plan' },
      'new Plan'
    )
    assert.equal(created.config.collaborationMode, 'plan')
    assert.equal(created.config.permissionMode, 'read-only')
  } finally {
    ;(AppServerRunner.prototype as any).setCollaborationMode = originalSetMode
    AppServerRunner.prototype.startTurn = originalStartTurn
    orchestrator.disposeAll()
    await rm(path, { force: true })
  }
}

async function orchestratorGoalLifecycle(): Promise<void> {
  const path = join(tmpdir(), `uniagent-native-goal-orchestrator-${process.pid}-${Date.now()}.json`)
  const store = new SessionStore(path)
  store.saveOrThrow([storedSession({ ...initialGoal, objective: 'stale cache' })])
  const orchestrator = new Orchestrator((id) => id === testAgent.id ? testAgent : undefined, store)
  orchestrator.loadPersisted()
  const originalEnsure = (AppServerRunner.prototype as any).ensureThreadReady
  const originalSet = AppServerRunner.prototype.setGoal
  const originalGet = (AppServerRunner.prototype as any).getGoal
  const originalClear = (AppServerRunner.prototype as any).clearGoal
  const originalStartTurn = AppServerRunner.prototype.startTurn
  const calls: NativeGoalAction[] = []
  const prompts: string[] = []
  const statusChanges: string[] = []
  const completeTurns = new Map<string, () => void>()
  orchestrator.on('statusChange', ({ sessionId, status }) => {
    if (sessionId === 'goal-session') statusChanges.push(status)
  })
  try {
    AppServerRunner.prototype.startTurn = async function (prompt: string): Promise<void> {
      prompts.push(prompt)
      const turnToken = `goal-turn-token-${prompts.length}`
      const turnId = `goal-turn-${prompts.length}`
      ;(this as any).startingTurnToken = undefined
      ;(this as any).activeTurnToken = turnToken
      ;(this as any).curTurnId = turnId
      this.emit('event', {
        sessionId: (this as any).sessionId,
        seq: ((this as any).seqRef as { n: number }).n++,
        ts: Date.now(),
        type: 'turn_started',
        payload: { threadId: 'thread-1', turnId }
      })
      const complete = (): void => {
        ;(this as any).onTurnCompleted({ id: turnId, status: 'completed' })
      }
      if (prompt === 'Goal 完成后的普通消息') {
        complete()
        return
      }
      completeTurns.set(prompt, complete)
      this.emit('goalChanged', {
        ...initialGoal,
        objective: prompt,
        status: 'complete'
      })
    }
    ;(AppServerRunner.prototype as any).ensureThreadReady = async function (): Promise<string> {
      if (!(this as any).threadId) {
        ;(this as any).threadId = 'thread-1'
        this.emit('event', {
          sessionId: 'new-goal-session',
          seq: 0,
          ts: Date.now(),
          type: 'turn_started',
          payload: { threadId: 'thread-1' }
        })
      }
      this.emit('goalChanged', undefined)
      return 'thread-1'
    }
    AppServerRunner.prototype.setGoal = async function (input: any): Promise<any> {
      await (this as any).ensureThreadReady()
      calls.push({ type: 'goal.set', ...input })
      const goal = { ...initialGoal, ...input }
      this.emit('goalChanged', goal)
      return goal
    } as typeof AppServerRunner.prototype.setGoal
    ;(AppServerRunner.prototype as any).getGoal = async (): Promise<GoalState | undefined> => initialGoal
    ;(AppServerRunner.prototype as any).clearGoal = async function (): Promise<void> {
      await (this as any).ensureThreadReady()
      calls.push({ type: 'goal.clear' })
      this.emit('goalChanged', undefined)
    }

    const native = orchestrator as Orchestrator & {
      runNativeAction(sessionId: string, action: NativeGoalAction): Promise<void>
      createNativeActionSession(config: SessionConfig, action: NativeGoalAction): Promise<Session>
    }
    const existing = orchestrator.getSessionById('goal-session')!
    assert.deepEqual((await orchestrator.getSessionRuntimeState(existing.id)).goal?.objective, 'stale cache')
    existing.readOnly = true
    await assert.rejects(
      native.runNativeAction(existing.id, { type: 'goal.clear' }),
      /只读会话/
    )
    existing.readOnly = false
    existing.status = 'running'
    await assert.rejects(
      native.runNativeAction(existing.id, { type: 'goal.clear' }),
      /任务或排队消息/
    )
    existing.status = 'idle'
    ;(orchestrator as any).pendingSends.set(existing.id, 1)
    await assert.rejects(
      native.runNativeAction(existing.id, { type: 'goal.clear' }),
      /消息正在发送/
    )
    ;(orchestrator as any).pendingSends.delete(existing.id)
    const hydratedBeforeGoal = (await orchestrator.getEvents(existing.id)).length
    await native.runNativeAction(existing.id, {
      type: 'goal.set',
      objective: '完成原生能力接入',
      tokenBudget: 12000
    })
    assert.equal(
      existing.status,
      'running',
      'Goal metadata completion must not finish the Session before provider turn/completed'
    )
    assert.equal(
      (await orchestrator.getEvents(existing.id))
        .slice(hydratedBeforeGoal)
        .filter((event) => event.type === 'turn_completed').length,
      0,
      'Goal metadata completion must not fabricate a turn_completed event'
    )
    completeTurns.get('完成原生能力接入')?.()
    await waitForReviewState(
      () => existing.status !== 'running',
      'completed Goal Session status'
    )
    assert.equal(existing.goal?.objective, '完成原生能力接入')
    assert.equal(existing.goal?.status, 'complete')
    assert.equal(new SessionStore(path).load()[0]?.goal?.status, 'complete')
    assert.deepEqual(
      (await orchestrator.getEvents(existing.id))
        .filter((event) => event.type === 'goal_message')
        .map((event) => event.payload.text),
      ['完成原生能力接入']
    )
    assert.ok(
      (await orchestrator.getEvents(existing.id)).length > hydratedBeforeGoal,
      'setting a Goal after restart must preserve the hydrated transcript'
    )
    assert.equal(existing.status, 'completed')
    assert.equal(statusChanges.at(-1), 'completed')
    assert.equal(new SessionStore(path).load()[0]?.status, 'completed')
    assert.deepEqual(prompts, ['完成原生能力接入'])

    await native.runNativeAction(existing.id, { type: 'goal.clear' })
    assert.equal(existing.goal, undefined)
    assert.equal(new SessionStore(path).load()[0]?.goal, undefined)

    AppServerRunner.prototype.setGoal = async function (): Promise<any> {
      throw new Error('provider rejected existing goal')
    } as typeof AppServerRunner.prototype.setGoal
    await assert.rejects(
      native.runNativeAction(existing.id, { type: 'goal.set', objective: '不能乐观写入' }),
      /provider rejected existing goal/
    )
    assert.equal(existing.goal, undefined)
    assert.equal(existing.status, 'completed')
    assert.equal(
      (await orchestrator.getEvents(existing.id)).filter((event) => event.type === 'goal_message').length,
      1,
      'a rejected Goal must not add a user bubble'
    )

    AppServerRunner.prototype.setGoal = async function (input: any): Promise<any> {
      await (this as any).ensureThreadReady()
      calls.push({ type: 'goal.set', ...input })
      const goal = { ...initialGoal, ...input }
      this.emit('goalChanged', goal)
      return goal
    } as typeof AppServerRunner.prototype.setGoal

    const created = await (native.createNativeActionSession as any)(
      baseConfig,
      { type: 'goal.set', objective: '  新 Goal 会话  ', tokenBudget: 99 },
      { handoffId: 'handoff-goal', handoffWaiting: true }
    )
    assert.equal(
      created.status,
      'running',
      'a new Goal Session must remain running until its provider turn completes'
    )
    completeTurns.get('新 Goal 会话')?.()
    await waitForReviewState(
      () => created.status !== 'running',
      'new completed Goal Session status'
    )
    assert.equal(created.title, '新 Goal 会话')
    assert.equal(created.status, 'completed')
    assert.equal(created.goal?.objective, '新 Goal 会话')
    assert.equal(created.handoffId, 'handoff-goal')
    assert.equal(created.handoffWaiting, true)
    assert.deepEqual(
      (await orchestrator.getEvents(created.id))
        .filter((event) => event.type === 'goal_message')
        .map((event) => event.payload.text),
      ['新 Goal 会话']
    )
    assert.deepEqual(orchestrator.getQueue(created.id), [])
    assert.equal(created.nativeSessionId, 'thread-1')
    assert.deepEqual(prompts, ['完成原生能力接入', '新 Goal 会话'])

    await assert.rejects(orchestrator.sendMessage(created.id, '尚未启用'), /只读会话/)
    orchestrator.enableToolSession(created.id)
    await orchestrator.sendMessage(created.id, 'Goal 完成后的普通消息')
    await waitForReviewState(
      () => created.status === 'idle',
      'ordinary turn after completed Goal Session'
    )
    assert.deepEqual(prompts, ['完成原生能力接入', '新 Goal 会话', 'Goal 完成后的普通消息'])
    assert.deepEqual(
      (await orchestrator.getEvents(created.id))
        .filter((event) => event.type === 'user_message')
        .map((event) => event.payload.text),
      ['Goal 完成后的普通消息'],
      'a completed Goal Session must accept a later ordinary user turn'
    )

    await assert.rejects(
      native.createNativeActionSession(baseConfig, { type: 'goal.clear' }),
      /只支持设置 Goal/
    )

    AppServerRunner.prototype.setGoal = async function (): Promise<any> {
      throw new Error('provider rejected goal')
    } as typeof AppServerRunner.prototype.setGoal
    const idsBeforeFailure = orchestrator.listSessions().map(({ id }) => id).sort()
    await assert.rejects(
      native.createNativeActionSession(baseConfig, { type: 'goal.set', objective: '失败 Goal' }),
      /provider rejected goal/
    )
    assert.deepEqual(orchestrator.listSessions().map(({ id }) => id).sort(), idsBeforeFailure)
    assert.equal(
      orchestrator.listSessions().some(({ title }) => title === '失败 Goal'),
      false,
      'provider failure must not leave a local orphan session'
    )
    const sessionIds = new Set(orchestrator.listSessions().map(({ id }) => id))
    assert.equal(
      [...(orchestrator as any).streamers.keys()].every((id: string) => sessionIds.has(id)),
      true,
      'provider failure must dispose the new runner together with its local session'
    )
  } finally {
    ;(AppServerRunner.prototype as any).ensureThreadReady = originalEnsure
    AppServerRunner.prototype.setGoal = originalSet
    ;(AppServerRunner.prototype as any).getGoal = originalGet
    ;(AppServerRunner.prototype as any).clearGoal = originalClear
    AppServerRunner.prototype.startTurn = originalStartTurn
    orchestrator.disposeAll()
    await rm(path, { force: true })
  }
}

async function orchestratorManualCompactGate(): Promise<void> {
  const path = join(tmpdir(), `uniagent-native-compact-${process.pid}-${Date.now()}.json`)
  const store = new SessionStore(path)
  store.saveOrThrow([storedSession()])
  let currentAgent: AgentDef = testAgent
  const orchestrator = new Orchestrator(
    (id) => id === currentAgent.id ? currentAgent : undefined,
    store
  )
  orchestrator.loadPersisted()
  const session = orchestrator.getSessionById('goal-session')!
  let compactCalls = 0
  const fakeStreamer = { compact: async () => { compactCalls += 1 } }
  try {
    await assert.rejects(
      orchestrator.compactSession(session.id),
      /尚未建立实时连接/
    )
    assert.equal((orchestrator as any).streamers.size, 0, 'manual compact must never create a runner')

    ;(orchestrator as any).streamers.set(session.id, fakeStreamer)
    await orchestrator.compactSession(session.id)
    assert.equal(compactCalls, 1)

    session.status = 'running'
    await assert.rejects(orchestrator.compactSession(session.id), /运行中/)
    session.status = 'idle'
    session.readOnly = true
    await assert.rejects(orchestrator.compactSession(session.id), /只读会话/)
    session.readOnly = false
    ;(orchestrator as any).pendingSends.set(session.id, 1)
    await assert.rejects(orchestrator.compactSession(session.id), /消息正在发送/)
    ;(orchestrator as any).pendingSends.delete(session.id)
    currentAgent = { ...testAgent, capabilities: { ...testAgent.capabilities, streaming: false } }
    await assert.rejects(orchestrator.compactSession(session.id), /不支持手动压缩/)
    assert.equal(compactCalls, 1)
  } finally {
    ;(orchestrator as any).streamers.delete(session.id)
    orchestrator.disposeAll()
    await rm(path, { force: true })
  }
}

async function nativeActionReservation(): Promise<void> {
  const path = join(tmpdir(), `uniagent-native-goal-reservation-${process.pid}-${Date.now()}.json`)
  const store = new SessionStore(path)
  store.saveOrThrow([storedSession(initialGoal)])
  const orchestrator = new Orchestrator((id) => id === testAgent.id ? testAgent : undefined, store)
  orchestrator.loadPersisted()
  const originalSet = AppServerRunner.prototype.setGoal
  const originalClear = (AppServerRunner.prototype as any).clearGoal
  const originalStartTurn = AppServerRunner.prototype.startTurn
  const pending = deferred<GoalState>()
  try {
    AppServerRunner.prototype.startTurn = async function (): Promise<void> {}
    AppServerRunner.prototype.setGoal = async function (): Promise<GoalState> {
      return pending.promise
    }
    ;(AppServerRunner.prototype as any).clearGoal = async function (): Promise<void> {}
    const session = orchestrator.getSessionById('goal-session')!
    const first = orchestrator.runNativeAction(session.id, {
      type: 'goal.set', objective: 'reserved Goal'
    })
    await assert.rejects(
      orchestrator.runNativeAction(session.id, { type: 'goal.clear' }),
      /native_action_in_progress/
    )
    await assert.rejects(
      orchestrator.sendMessage(session.id, 'must not overtake Goal'),
      /native_action_in_progress/
    )
    await assert.rejects(
      orchestrator.forceSend(session.id, 'must not force over Goal'),
      /native_action_in_progress/
    )
    assert.match(
      (await orchestrator.previewSessionRewind(session.id, 'turn-1')).reason || '',
      /原生操作正在进行/
    )

    pending.resolve({ ...initialGoal, objective: 'reserved Goal' })
    await first
    session.status = 'idle'
    await orchestrator.runNativeAction(session.id, { type: 'goal.clear' })

    const history = deferred<UAEvent[]>()
    ;(orchestrator as any).getEvents = (): Promise<UAEvent[]> => history.promise
    const sendTail = orchestrator.sendMessage(session.id, 'accepted before reservation')
    await Promise.resolve()
    ;(orchestrator as any).nativeActionReservations.add(session.id)
    history.resolve([])
    await assert.rejects(sendTail, /native_action_in_progress/)
    ;(orchestrator as any).nativeActionReservations.delete(session.id)
    assert.equal(
      ((orchestrator as any).events.get(session.id) as UAEvent[]).some(
        (event) => event.type === 'user_message' && event.payload?.text === 'accepted before reservation'
      ),
      false,
      'the send tail must re-check reservation after its history await'
    )

    AppServerRunner.prototype.setGoal = async function (): Promise<GoalState> {
      throw new Error('reserved provider failure')
    }
    await assert.rejects(
      orchestrator.runNativeAction(session.id, { type: 'goal.set', objective: 'failure releases' }),
      /reserved provider failure/
    )
    await orchestrator.runNativeAction(session.id, { type: 'goal.clear' })
  } finally {
    AppServerRunner.prototype.setGoal = originalSet
    ;(AppServerRunner.prototype as any).clearGoal = originalClear
    AppServerRunner.prototype.startTurn = originalStartTurn
    orchestrator.disposeAll()
    await rm(path, { force: true })
  }
}

function nativeGoalDtoValidation(): void {
  const parse = (nativeContracts as any).parseNativeGoalAction as
    | ((value: unknown) => NativeGoalAction)
    | undefined
  assert.equal(typeof parse, 'function', 'native Goal actions need one strict shared parser used by main IPC')
  assert.deepEqual(parse!({ type: 'goal.set', objective: '  ship it  ', tokenBudget: 7 }), {
    type: 'goal.set', objective: 'ship it', tokenBudget: 7
  })
  assert.deepEqual(parse!({ type: 'goal.clear' }), { type: 'goal.clear' })
  for (const invalid of [
    null,
    {},
    { type: 'goal.set', objective: '   ' },
    { type: 'goal.set', objective: 'x', tokenBudget: 0 },
    { type: 'goal.set', objective: 'x', tokenBudget: 1.5 },
    { type: 'goal.set', objective: 'x', tokenBudget: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'goal.set', objective: 'x', extra: true },
    { type: 'goal.clear', objective: 'forged' },
    { type: 'review.start' }
  ]) {
    assert.throws(() => parse!(invalid), /invalid_native_goal_action/)
  }
}

function nativeReviewTargetMapping(): void {
  const build = (appServerAdapter as any).buildNativeReviewTarget as
    | ((draft: NativeReviewDraft) => unknown)
    | undefined
  assert.equal(typeof build, 'function', 'Review needs one provider-native target builder')
  assert.deepEqual(build!({ scope: { type: 'uncommittedChanges' } }), {
    type: 'uncommittedChanges'
  })
  assert.deepEqual(build!({
    scope: { type: 'uncommittedChanges' },
    instructions: '  重点检查权限降级  '
  }), {
    type: 'custom',
    instructions: '审查当前工作区的未提交改动。\n\n补充要求：重点检查权限降级'
  })
  assert.deepEqual(build!({ scope: { type: 'baseBranch', branch: 'master' } }), {
    type: 'custom',
    instructions: '审查当前工作区相对 base branch「master」的改动。'
  })
  assert.deepEqual(build!({
    scope: { type: 'baseBranch', branch: 'master' },
    instructions: '  重点检查权限降级  '
  }), {
    type: 'custom',
    instructions: '审查当前工作区相对 base branch「master」的改动。\n\n补充要求：重点检查权限降级'
  })
  assert.deepEqual(build!({ scope: { type: 'commit', sha: 'abc123', title: 'feat' } }), {
    type: 'commit', sha: 'abc123', title: 'feat'
  })
  assert.deepEqual(build!({ scope: { type: 'commit', sha: 'abc123', title: '' } }), {
    type: 'commit', sha: 'abc123', title: null
  })
  assert.deepEqual(build!({
    scope: { type: 'commit', sha: 'abc123', title: 'feat' },
    instructions: '只看并发边界'
  }), {
    type: 'custom',
    instructions: '审查 commit「abc123」。\n\n补充要求：只看并发边界'
  })
  assert.deepEqual(build!({
    scope: { type: 'custom' },
    instructions: '  检查自定义范围  '
  }), {
    type: 'custom', instructions: '检查自定义范围'
  })
  assert.throws(
    () => build!({ scope: { type: 'custom' }, instructions: '   ' }),
    /自定义 Review 必须填写要求/
  )
}

function nativeThreadActionDtoValidation(): void {
  const parse = (nativeContracts as any).parseNativeThreadAction as
    | ((value: unknown) => NativeThreadAction)
    | undefined
  assert.equal(typeof parse, 'function', 'main IPC needs one strict NativeThreadAction parser')
  assert.deepEqual(parse!({ type: 'goal.clear' }), { type: 'goal.clear' })
  assert.deepEqual(parse!({
    type: 'review.start',
    draft: {
      scope: { type: 'baseBranch', branch: '  master  ' },
      instructions: '  检查权限  '
    }
  }), {
    type: 'review.start',
    draft: {
      scope: { type: 'baseBranch', branch: 'master' },
      instructions: '检查权限'
    }
  })
  assert.deepEqual(parse!({
    type: 'review.start',
    draft: { scope: { type: 'commit', sha: '  abc123  ', title: '  feat  ' } }
  }), {
    type: 'review.start',
    draft: { scope: { type: 'commit', sha: 'abc123', title: 'feat' } }
  })
  assert.deepEqual(parse!({
    type: 'review.start',
    draft: { scope: { type: 'custom' }, instructions: '  只检查可信边界  ' }
  }), {
    type: 'review.start',
    draft: { scope: { type: 'custom' }, instructions: '只检查可信边界' }
  })
  for (const invalid of [
    { type: 'review.start' },
    { type: 'review.start', draft: null },
    { type: 'review.start', draft: { scope: null } },
    { type: 'review.start', draft: { scope: { type: 'uncommittedChanges', branch: 'forged' } } },
    { type: 'review.start', draft: { scope: { type: 'baseBranch', branch: '   ' } } },
    { type: 'review.start', draft: { scope: { type: 'baseBranch', branch: 'master', sha: 'forged' } } },
    { type: 'review.start', draft: { scope: { type: 'commit', sha: '   ' } } },
    { type: 'review.start', draft: { scope: { type: 'commit', sha: 'abc', title: 7 } } },
    { type: 'review.start', draft: { scope: { type: 'custom' } } },
    { type: 'review.start', draft: { scope: { type: 'custom' }, instructions: '   ' } },
    { type: 'review.start', draft: { scope: { type: 'custom' }, instructions: 'x', extra: true } },
    { type: 'review.start', draft: { scope: { type: 'custom' }, instructions: 'x' }, objective: 'forged Goal' },
    { type: 'goal.set', objective: 'forged hybrid', draft: { scope: { type: 'custom' }, instructions: 'x' } }
  ]) {
    assert.throws(() => parse!(invalid), /invalid_native_thread_action/)
  }
}

async function trackedReviewRpcLifecycle(): Promise<void> {
  const { runner, transport } = recordingRunner()
  const events: UAEvent[] = []
  const done: any[] = []
  runner.on('event', (event) => events.push(event))
  runner.on('done', (event) => done.push(event))
  try {
    await runner.startReview({ scope: { type: 'uncommittedChanges' } })
    assert.deepEqual(transport.workflowRequests.map(({ method }) => method), [
      'initialize', 'thread/start', 'thread/goal/get', 'review/start'
    ])
    assert.deepEqual(transport.requests.at(-1), {
      method: 'review/start',
      params: {
        threadId: 'thread-1',
        target: { type: 'uncommittedChanges' },
        delivery: 'inline'
      }
    })
    assert.deepEqual(
      events.filter(({ type, payload }) => type === 'turn_started' && payload?.turnId)
        .map(({ payload }) => payload),
      [{ turnId: 'review-1', threadId: 'thread-1' }]
    )
    await assert.rejects(
      runner.startReview({ scope: { type: 'uncommittedChanges' } }),
      /当前已有 turn 正在运行/
    )
    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'review-1', status: 'completed' }
    })
    assert.equal(done.length, 1)
    assert.deepEqual(
      events.filter(({ type }) => type === 'turn_completed').map(({ state, payload }) => ({ state, payload })),
      [{ state: 'success', payload: { turnId: 'review-1' } }]
    )

    transport.reviewTurnId = 'review-2'
    await runner.startReview({
      scope: { type: 'commit', sha: 'abc123', title: 'feat' }
    })
    assert.deepEqual(transport.requests.at(-1)?.params, {
      threadId: 'thread-1',
      target: { type: 'commit', sha: 'abc123', title: 'feat' },
      delivery: 'inline'
    })
  } finally {
    runner.dispose()
  }
}

async function reviewRpcFailureCleanup(): Promise<void> {
  for (const scenario of ['missing-turn', 'mismatched-thread', 'provider-error'] as const) {
    const transport = new RecordingTransport()
    const replacement = new RecordingTransport()
    const runner = scenario === 'provider-error'
      ? recordingRunnerSequence([transport])
      : recordingRunnerSequence([transport, replacement])
    const events: UAEvent[] = []
    runner.on('event', (event) => events.push(event))
    if (scenario === 'missing-turn') transport.reviewTurnId = undefined
    if (scenario === 'mismatched-thread') transport.reviewThreadId = 'detached-thread'
    if (scenario === 'provider-error') transport.failReview = true
    if (scenario !== 'provider-error') {
      transport.beforeReviewResponseNotifications.push(
        {
          method: 'item/completed',
          params: {
            threadId: scenario === 'mismatched-thread' ? 'detached-thread' : 'thread-1',
            item: { id: `early-${scenario}`, type: 'agentMessage', text: `pollution-${scenario}` }
          }
        },
        {
          method: 'turn/diff/updated',
          params: {
            threadId: scenario === 'mismatched-thread' ? 'detached-thread' : 'thread-1',
            turnId: 'untrusted-review',
            diff: reviewDiff('polluted.ts', 'before', 'after')
          }
        },
        {
          method: 'turn/completed',
          params: {
            threadId: scenario === 'mismatched-thread' ? 'detached-thread' : 'thread-1',
            turn: { id: 'untrusted-review', status: 'completed' }
          }
        }
      )
    }
    try {
      await assert.rejects(
        runner.startReview({ scope: { type: 'uncommittedChanges' } }),
        scenario === 'missing-turn'
          ? /review\/start 未返回 turn id/
          : scenario === 'mismatched-thread'
            ? /inline review 返回了不同 thread/
            : /provider rejected review/
      )
      assert.equal(
        events.some(({ type, state }) => type === 'turn_completed' && state === 'success'),
        false,
        `${scenario} must not fabricate a successful turn`
      )
      assert.match(
        String(events.find(({ type }) => type === 'error')?.payload?.message),
        /review\/start 失败/
      )

      if (scenario !== 'provider-error') {
        assert.equal(transport.disposeCalls, 1, `${scenario} must invalidate its untrusted transport`)
        assert.equal(
          events.some(({ payload }) => payload?.text === `pollution-${scenario}` || payload?.turnId === 'untrusted-review'),
          false,
          `${scenario} must discard response-before-notification state`
        )
        transport.emit('notification', 'item/completed', {
          threadId: scenario === 'mismatched-thread' ? 'detached-thread' : 'thread-1',
          item: { id: `late-${scenario}`, type: 'agentMessage', text: `late-pollution-${scenario}` }
        })
        assert.equal(
          events.some(({ payload }) => payload?.text === `late-pollution-${scenario}`),
          false,
          `${scenario} must ignore late notifications from the invalidated transport`
        )
      }

      const recoveryTransport = scenario === 'provider-error' ? transport : replacement
      recoveryTransport.reviewTurnId = `recovered-${scenario}`
      recoveryTransport.reviewThreadId = 'thread-1'
      recoveryTransport.failReview = false
      await runner.startReview({ scope: { type: 'uncommittedChanges' } })
      assert.equal(
        events.some(({ type, payload }) =>
          type === 'turn_started' && payload?.turnId === `recovered-${scenario}`
        ),
        true,
        `${scenario} must release the runner turn reservation`
      )
    } finally {
      runner.dispose()
    }
  }

  const { runner, transport } = recordingRunner()
  try {
    await assert.rejects(
      runner.startReview({ scope: { type: 'custom' }, instructions: '   ' }),
      /自定义 Review 必须填写要求/
    )
    assert.equal(
      transport.requests.some(({ method }) => method === 'review/start'),
      false,
      'invalid custom Review must fail before provider mutation'
    )
  } finally {
    runner.dispose()
  }
}

async function bufferedReviewStartupOrdering(): Promise<void> {
  const { runner, transport } = recordingRunner()
  const events: UAEvent[] = []
  const done: any[] = []
  runner.on('event', (event) => events.push(event))
  runner.on('done', (event) => done.push(event))
  transport.beforeReviewResponseNotifications.push(
    {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'review-1',
        item: { id: 'review-message', type: 'agentMessage', text: '审查' }
      }
    },
    {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'review-1', itemId: 'review-message', delta: '结果' }
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'review-1',
        item: { id: 'review-message', type: 'agentMessage', text: '审查结果' }
      }
    },
    {
      method: 'turn/diff/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'review-1',
        diff: reviewDiff('review.ts', 'before', 'after')
      }
    },
    {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'review-1', status: 'completed' } }
    }
  )
  try {
    await runner.startReview({ scope: { type: 'uncommittedChanges' } })
    const startedIndex = events.findIndex(({ type, payload }) =>
      type === 'turn_started' && payload?.turnId === 'review-1'
    )
    const messageIndex = events.findIndex(({ type, state, payload }) =>
      type === 'agent_message' && state === 'success' && payload?.text === '审查结果'
    )
    const diffIndex = events.findIndex(({ type, payload }) =>
      type === 'diff_update' && payload?.turnId === 'review-1'
    )
    const completedIndex = events.findIndex(({ type, payload }) =>
      type === 'turn_completed' && payload?.turnId === 'review-1'
    )
    assert.ok(startedIndex >= 0)
    assert.ok(startedIndex < messageIndex && messageIndex < diffIndex && diffIndex < completedIndex)
    assert.equal(done.length, 1, 'an early completion must still settle exactly once after replay')
  } finally {
    runner.dispose()
  }
}

async function reviewBufferStartsAtReviewRequestBoundary(): Promise<void> {
  for (const resume of [false, true]) {
    const transport = new RecordingTransport()
    const threadId = resume ? 'thread-existing' : 'thread-boundary-new'
    transport.startedThreadId = threadId
    transport.reviewThreadId = threadId
    transport.reviewTurnId = `review-boundary-${resume ? 'resume' : 'start'}`
    transport.goal = { ...initialGoal, objective: `goal-before-review-${resume}` }
    const threadMethod = resume ? 'thread/resume' : 'thread/start'
    transport.beforeMethodResponseNotifications.set('initialize', [{
      method: 'item/completed',
      params: {
        item: {
          id: `ordinary-initialize-${resume}`,
          type: 'agentMessage',
          text: `ordinary initialize ${resume}`
        }
      }
    }])
    transport.beforeMethodResponseNotifications.set(threadMethod, [{
      method: 'turn/plan/updated',
      params: {
        plan: [{ step: `ordinary connection plan ${resume}`, status: 'in_progress' }],
        explanation: `ordinary-plan-${resume}`
      }
    }])
    transport.beforeMethodResponseNotifications.set('thread/goal/get', [
      {
        method: 'error',
        params: { error: { message: `ordinary connection error ${resume}` } }
      },
      {
        method: 'thread/goal/updated',
        params: {
          threadId,
          goal: { ...initialGoal, objective: `goal-notification-before-review-${resume}`, updatedAt: 2 }
        }
      }
    ])
    transport.beforeMethodResponseNotifications.set('collaborationMode/list', [{
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        tokenUsage: { last: { inputTokens: 17 }, total: { inputTokens: 17, outputTokens: 1 } }
      }
    }])
    transport.beforeMethodResponseNotifications.set('thread/settings/update', [
      {
        method: 'queue/status',
        params: { state: 'waiting', message: `ordinary queue ${resume}` }
      },
      {
        method: 'thread/settings/updated',
        params: {
          threadId,
          threadSettings: { collaborationMode: { mode: 'plan', settings: {} } }
        }
      }
    ])
    transport.beforeReviewResponseNotifications.push(
      {
        method: 'item/completed',
        params: {
          threadId,
          turnId: transport.reviewTurnId,
          item: {
            id: `review-message-${resume}`,
            type: 'agentMessage',
            text: `review result ${resume}`
          }
        }
      },
      {
        method: 'turn/diff/updated',
        params: {
          threadId,
          turnId: transport.reviewTurnId,
          diff: reviewDiff('boundary.ts', 'before', 'after')
        }
      },
      {
        method: 'turn/completed',
        params: {
          threadId,
          turn: { id: transport.reviewTurnId, status: 'completed' }
        }
      }
    )
    const config: SessionConfig = {
      ...baseConfig,
      collaborationMode: 'plan',
      model: 'configured-model'
    }
    const runner = recordingRunnerSequence([transport], resume ? threadId : undefined, config)
    const events: UAEvent[] = []
    const goals: Array<GoalState | undefined> = []
    const collaborationModes: string[] = []
    runner.on('event', (event) => events.push(event))
    runner.on('goalChanged', (goal) => goals.push(goal))
    runner.on('collaborationModeChanged', (mode) => collaborationModes.push(mode))
    try {
      await runner.startReview({ scope: { type: 'uncommittedChanges' } })
      const reviewStarted = events.findIndex(({ type, payload }) =>
        type === 'turn_started' && payload?.turnId === transport.reviewTurnId
      )
      assert.ok(reviewStarted >= 0)
      const ordinaryIndexes = [
        events.findIndex(({ type, payload }) =>
          type === 'agent_message' && payload?.text === `ordinary initialize ${resume}`
        ),
        events.findIndex(({ type, payload }) =>
          type === 'plan_update' && payload?.explanation === `ordinary-plan-${resume}`
        ),
        events.findIndex(({ type, payload }) =>
          type === 'error' && payload?.message === `ordinary connection error ${resume}`
        ),
        events.findIndex(({ type, payload }) =>
          type === 'system_notice' && payload?.kind === 'context'
        ),
        events.findIndex(({ type, payload }) =>
          type === 'queue_status' && payload?.queue?.message === `ordinary queue ${resume}`
        )
      ]
      assert.equal(ordinaryIndexes.every((index) => index >= 0 && index < reviewStarted), true)
      assert.equal(
        events.some(({ type, payload }) =>
          type === 'plan_update' && payload?.id === `plan-${transport.reviewTurnId}` &&
          payload?.explanation === `ordinary-plan-${resume}`
        ),
        false,
        'connection-time id-less Plan must not be rebound to the Review turn'
      )
      const reviewMessage = events.findIndex(({ type, payload }) =>
        type === 'agent_message' && payload?.text === `review result ${resume}`
      )
      const reviewDiff = events.findIndex(({ type, payload }) =>
        type === 'diff_update' && payload?.turnId === transport.reviewTurnId
      )
      assert.ok(reviewStarted < reviewMessage && reviewMessage < reviewDiff)
      assert.equal(goals.at(-1)?.objective, `goal-notification-before-review-${resume}`)
      assert.deepEqual(collaborationModes, ['plan'])
    } finally {
      runner.dispose()
    }
  }
}

type ReviewConnectionStage = {
  name: string
  method: string
  resumeThreadId?: string
  plan?: boolean
}

const reviewConnectionStages: ReviewConnectionStage[] = [
  { name: 'initialize', method: 'initialize' },
  { name: 'thread-start', method: 'thread/start' },
  { name: 'thread-resume', method: 'thread/resume', resumeThreadId: 'thread-existing' },
  { name: 'goal-refresh', method: 'thread/goal/get' },
  { name: 'plan-list', method: 'collaborationMode/list', resumeThreadId: 'thread-existing', plan: true },
  { name: 'plan-settings', method: 'thread/settings/update', resumeThreadId: 'thread-existing', plan: true }
]

async function drainConnectionContinuations(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function interruptedConnectAttemptCannotPolluteReviewRetry(): Promise<void> {
  for (const stage of reviewConnectionStages) {
    const blocker = deferred<void>()
    const oldTransport = new RecordingTransport()
    oldTransport.startedThreadId = `thread-old-${stage.name}`
    oldTransport.threadModel = `model-old-${stage.name}`
    oldTransport.goal = { ...initialGoal, objective: `goal-old-${stage.name}` }
    oldTransport.requestWaits.set(stage.method, blocker.promise)
    if (stage.method === 'thread/settings/update') (oldTransport as any).wireSequence = 100

    const identityWasCommittedBeforeCancellation = [
      'thread/goal/get', 'collaborationMode/list', 'thread/settings/update'
    ].includes(stage.method)
    const expectedThreadId = stage.resumeThreadId || (
      identityWasCommittedBeforeCancellation
        ? oldTransport.startedThreadId
        : `thread-new-${stage.name}`
    )
    const replacement = new RecordingTransport()
    replacement.startedThreadId = `thread-new-${stage.name}`
    replacement.reviewThreadId = expectedThreadId
    replacement.reviewTurnId = `review-new-${stage.name}`
    replacement.threadModel = `model-new-${stage.name}`
    replacement.goal = { ...initialGoal, objective: `goal-new-${stage.name}` }
    const config: SessionConfig = {
      ...baseConfig,
      ...(stage.plan ? { collaborationMode: 'plan' as const, model: 'configured-model' } : {})
    }
    const runner = recordingRunnerSequence(
      [oldTransport, replacement],
      stage.resumeThreadId,
      config
    )
    const done: any[] = []
    const events: UAEvent[] = []
    runner.on('done', (event) => done.push(event))
    runner.on('event', (event) => events.push(event))
    try {
      const first = runner.startReview({ scope: { type: 'uncommittedChanges' } })
      await waitForReviewState(
        () => oldTransport.requests.some(({ method }) => method === stage.method),
        `old ${stage.name} request`
      )
      const oldMethodsAtCancellation = oldTransport.requests.map(({ method }) => method)
      runner.interrupt()
      const cancelled = await settleReviewWithin(first)
      assert.equal(cancelled.status, 'rejected', `${stage.name} cancellation must reject locally`)

      await runner.startReview({ scope: { type: 'uncommittedChanges' } })
      const replacementMethodsBeforeLateResponse = replacement.requests.map(({ method }) => method)
      const replacementState = {
        threadId: (runner as any).threadId,
        negotiatedModel: (runner as any).negotiatedModel,
        goalState: structuredClone((runner as any).goalState),
        collaborationSequence: (runner as any).lastCollaborationModeWireSequence
      }
      assert.equal(replacementState.threadId, expectedThreadId)

      blocker.resolve()
      await drainConnectionContinuations()
      assert.deepEqual(
        oldTransport.requests.map(({ method }) => method),
        oldMethodsAtCancellation,
        `${stage.name} old attempt must stop issuing RPCs after cancellation`
      )
      assert.deepEqual(
        replacement.requests.map(({ method }) => method),
        replacementMethodsBeforeLateResponse,
        `${stage.name} old continuation must not issue RPCs on the replacement transport`
      )
      assert.deepEqual(
        {
          threadId: (runner as any).threadId,
          negotiatedModel: (runner as any).negotiatedModel,
          goalState: (runner as any).goalState,
          collaborationSequence: (runner as any).lastCollaborationModeWireSequence
        },
        replacementState,
        `${stage.name} late response must not overwrite replacement connection state`
      )

      const approvalsBeforeLateRequest = events.filter(({ type }) => type === 'approval_request').length
      oldTransport.emit('serverRequest', {
        id: `late-${stage.name}`,
        method: 'item/commandExecution/requestApproval',
        params: {}
      })
      assert.equal(
        events.filter(({ type }) => type === 'approval_request').length,
        approvalsBeforeLateRequest,
        `${stage.name} late server request must stay detached`
      )

      replacement.emit('notification', 'turn/completed', {
        threadId: expectedThreadId,
        turn: { id: replacement.reviewTurnId, status: 'completed' }
      })
      assert.equal(done.at(-1)?.nativeSessionId, expectedThreadId)
      assert.equal(done.at(-1)?.interrupted, false)
    } finally {
      runner.dispose()
    }
  }
}

async function disposedConnectAttemptCannotContinue(): Promise<void> {
  for (const stage of reviewConnectionStages) {
    const blocker = deferred<void>()
    const transport = new RecordingTransport()
    transport.startedThreadId = `thread-disposed-${stage.name}`
    transport.threadModel = `model-disposed-${stage.name}`
    transport.requestWaits.set(stage.method, blocker.promise)
    const config: SessionConfig = {
      ...baseConfig,
      ...(stage.plan ? { collaborationMode: 'plan' as const, model: 'configured-model' } : {})
    }
    const runner = recordingRunnerSequence([transport], stage.resumeThreadId, config)
    const events: UAEvent[] = []
    runner.on('event', (event) => events.push(event))
    const starting = runner.startReview({ scope: { type: 'uncommittedChanges' } })
    await waitForReviewState(
      () => transport.requests.some(({ method }) => method === stage.method),
      `disposed ${stage.name} request`
    )
    const methodsAtDispose = transport.requests.map(({ method }) => method)
    runner.dispose()
    const disposed = await settleReviewWithin(starting)
    assert.equal(disposed.status, 'rejected', `${stage.name} dispose must reject locally`)
    const stateAtDispose = {
      threadId: (runner as any).threadId,
      negotiatedModel: (runner as any).negotiatedModel,
      goalState: structuredClone((runner as any).goalState),
      collaborationSequence: (runner as any).lastCollaborationModeWireSequence
    }
    const eventsAtDispose = events.length
    blocker.resolve()
    await drainConnectionContinuations()
    assert.deepEqual(transport.requests.map(({ method }) => method), methodsAtDispose)
    assert.deepEqual(
      {
        threadId: (runner as any).threadId,
        negotiatedModel: (runner as any).negotiatedModel,
        goalState: (runner as any).goalState,
        collaborationSequence: (runner as any).lastCollaborationModeWireSequence
      },
      stateAtDispose,
      `${stage.name} late response must not mutate a disposed runner`
    )
    assert.equal(events.length, eventsAtDispose, `${stage.name} late response must not emit events`)
    assert.equal(transport.disposeCalls, 1)
  }
}

async function failedReviewCompletionLifecycle(): Promise<void> {
  const { runner, transport } = recordingRunner()
  const events: UAEvent[] = []
  const done: any[] = []
  runner.on('event', (event) => events.push(event))
  runner.on('done', (event) => done.push(event))
  try {
    await runner.startReview({ scope: { type: 'uncommittedChanges' } })
    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'review-1', status: 'failed', error: { message: 'async review failed' } }
    })
    assert.equal(
      events.some(({ type, state, payload }) =>
        type === 'turn_completed' && state === 'failed' && payload?.turnId === 'review-1'
      ),
      true,
      'provider failed completion must not be normalized to success'
    )
    assert.deepEqual(done, [{ nativeSessionId: 'thread-1', interrupted: false, failed: true }])
    assert.equal((runner as any).activeTurnToken, undefined)
    assert.equal((runner as any).curTurnId, undefined)

    transport.reviewTurnId = 'review-after-failure'
    await runner.startReview({ scope: { type: 'uncommittedChanges' } })
    assert.equal((runner as any).curTurnId, 'review-after-failure')
  } finally {
    runner.dispose()
  }
}

type PromiseSettlement =
  | { status: 'fulfilled' }
  | { status: 'rejected'; error: unknown }
  | { status: 'timeout' }

async function settleReviewWithin(promise: Promise<void>, timeoutMs = 75): Promise<PromiseSettlement> {
  return Promise.race([
    promise.then<PromiseSettlement>(
      () => ({ status: 'fulfilled' }),
      (error) => ({ status: 'rejected', error })
    ),
    new Promise<PromiseSettlement>((resolve) => {
      setTimeout(() => resolve({ status: 'timeout' }), timeoutMs)
    })
  ])
}

async function startingReviewLocalCancellation(): Promise<void> {
  const interruptedBlocker = deferred<void>()
  const interruptedTransport = new RecordingTransport()
  interruptedTransport.reviewStartWait = interruptedBlocker.promise
  const replacement = new RecordingTransport()
  replacement.reviewTurnId = 'review-after-interrupt'
  const runner = recordingRunnerSequence([interruptedTransport, replacement])
  const events: UAEvent[] = []
  const done: any[] = []
  runner.on('event', (event) => events.push(event))
  runner.on('done', (event) => done.push(event))
  const starting = runner.startReview({ scope: { type: 'uncommittedChanges' } })
  await waitForReviewState(
    () => interruptedTransport.requests.at(-1)?.method === 'review/start',
    'pending review before interrupt'
  )
  runner.interrupt()
  const interrupted = await settleReviewWithin(starting)
  if (interrupted.status === 'timeout') {
    interruptedBlocker.resolve()
    await starting
    interruptedTransport.emit('notification', 'turn/completed', {
      threadId: 'thread-1', turn: { id: 'review-1', status: 'interrupted' }
    })
  }
  assert.equal(interrupted.status, 'rejected', 'interrupt must settle a pending review/start locally')
  assert.match(String(interrupted.status === 'rejected' ? interrupted.error : ''), /review\/start.*\u4e2d断/i)
  assert.equal(interruptedTransport.disposeCalls, 1, 'interrupt must retire only the pending Review transport')
  assert.equal(
    events.filter(({ type, state }) => type === 'turn_completed' && state === 'cancelled').length,
    1
  )
  assert.deepEqual(done, [{ nativeSessionId: 'thread-1', interrupted: true }])
  assert.equal((runner as any).startingReviewToken, undefined)
  assert.equal((runner as any).startingTurnToken, undefined)
  assert.equal((runner as any).activeTurnToken, undefined)
  assert.equal((runner as any).compactionActivity.manualUnavailableReason(), undefined)

  interruptedTransport.emit('notification', 'item/completed', {
    threadId: 'thread-1',
    item: { id: 'late-interrupted', type: 'agentMessage', text: 'late interrupted pollution' }
  })
  assert.equal(events.some(({ payload }) => payload?.text === 'late interrupted pollution'), false)

  await runner.startReview({ scope: { type: 'uncommittedChanges' } })
  assert.equal((runner as any).curTurnId, 'review-after-interrupt')
  runner.dispose()

  const disposedBlocker = deferred<void>()
  const disposedTransport = new RecordingTransport()
  disposedTransport.reviewStartWait = disposedBlocker.promise
  const disposedRunner = recordingRunnerSequence([disposedTransport])
  const disposedEvents: UAEvent[] = []
  const disposedDone: any[] = []
  disposedRunner.on('event', (event) => disposedEvents.push(event))
  disposedRunner.on('done', (event) => disposedDone.push(event))
  const disposing = disposedRunner.startReview({ scope: { type: 'uncommittedChanges' } })
  await waitForReviewState(
    () => disposedTransport.requests.at(-1)?.method === 'review/start',
    'pending review before dispose'
  )
  disposedRunner.dispose()
  const disposed = await settleReviewWithin(disposing)
  if (disposed.status === 'timeout') disposedBlocker.resolve()
  assert.equal(disposed.status, 'rejected', 'dispose must settle a pending review/start locally')
  assert.equal(disposedTransport.disposeCalls, 1)
  assert.equal(
    disposedEvents.filter(({ type, state }) => type === 'turn_completed' && state === 'cancelled').length,
    1
  )
  assert.deepEqual(disposedDone, [{ nativeSessionId: undefined, interrupted: true }], 'dispose clears the runner identity before publishing terminal state')
  assert.equal((disposedRunner as any).compactionActivity.manualUnavailableReason(), undefined)
}

function reviewDiff(path: string, before: string, after: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,1 @@',
    `-${before}`,
    `+${after}`
  ].join('\n')
}

async function waitForReviewState(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function orchestratorReviewLifecycle(): Promise<void> {
  const root = join(tmpdir(), `uniagent-native-review-${process.pid}-${Date.now()}`)
  const workdir = join(root, 'work')
  const store = new SessionStore(join(root, 'sessions.json'))
  const existing = {
    ...storedSession(initialGoal),
    config: { ...baseConfig, workdir },
    nativeSessionId: 'thread-existing'
  }
  await mkdir(workdir, { recursive: true })
  await writeFile(join(workdir, 'review.ts'), 'after')
  store.saveOrThrow([existing])
  const orchestrator = new Orchestrator(
    (id) => id === testAgent.id ? testAgent : undefined,
    store,
    join(root, 'artifacts')
  )
  orchestrator.loadPersisted()
  const originalStartReview = AppServerRunner.prototype.startReview
  const queuedTransports: RecordingTransport[] = []
  try {
    await (orchestrator as any).artifacts.finalize({
      sessionId: existing.id,
      nativeThreadId: 'thread-existing',
      nativeTurnId: 'prior-turn',
      startSeq: 0,
      endSeq: 0,
      startedAt: 1,
      completedAt: 2,
      unifiedDiff: '',
      workdir
    })

    AppServerRunner.prototype.startReview = async function (draft: NativeReviewDraft): Promise<void> {
      if (!(this as any).transport) {
        const transport = queuedTransports.shift() || new RecordingTransport()
        ;(this as any).transportFactory = () => transport
      }
      return originalStartReview.call(this, draft)
    }

    const current = orchestrator.getSessionById(existing.id)!
    const firstTransport = new RecordingTransport()
    firstTransport.goal = initialGoal
    firstTransport.reviewThreadId = 'thread-existing'
    firstTransport.reviewTurnId = 'review-existing'
    firstTransport.beforeReviewResponseNotifications.push({
      method: 'turn/diff/updated',
      params: {
        threadId: 'thread-existing',
        turnId: 'review-existing',
        diff: reviewDiff('review.ts', 'before', 'after')
      }
    })
    queuedTransports.push(firstTransport)
    await orchestrator.runNativeAction(existing.id, {
      type: 'review.start',
      draft: { scope: { type: 'uncommittedChanges' } }
    })
    assert.equal(current.status, 'running')
    assert.deepEqual(current.goal, initialGoal)
    assert.equal((await orchestrator.getEvents(existing.id)).some(({ type }) => type === 'user_message'), false)
    assert.deepEqual(orchestrator.getQueue(existing.id), [])
    assert.deepEqual(firstTransport.requests.at(-1)?.params, {
      threadId: 'thread-existing',
      target: { type: 'uncommittedChanges' },
      delivery: 'inline'
    })

    firstTransport.emit('notification', 'turn/completed', {
      threadId: 'thread-existing',
      turn: { id: 'review-existing', status: 'completed' }
    })
    await waitForReviewState(() => current.status === 'idle', 'existing Review completion')
    const existingSummary = await orchestrator.getTurnArtifactSummary(existing.id, 'review-existing')
    assert.equal(existingSummary?.state, 'ready')
    assert.deepEqual(existingSummary?.files.map(({ path }) => path), ['review.ts'])
    const existingEvents = await orchestrator.getEvents(existing.id)
    assert.ok(
      existingEvents.findIndex(({ type, payload }) =>
        type === 'turn_started' && payload?.turnId === 'review-existing'
      ) < existingEvents.findIndex(({ type, payload }) =>
        type === 'diff_update' && payload?.turnId === 'review-existing'
      ),
      'Review startup diff must replay only after turn_started established artifact capture'
    )
    assert.deepEqual(
      (await (orchestrator as any).artifacts.list(existing.id)).map((item: any) => item.nativeTurnId),
      ['prior-turn', 'review-existing'],
      'inline Review finalization must append without corrupting prior turn history'
    )

    firstTransport.reviewTurnId = 'review-provider-failed'
    await orchestrator.runNativeAction(existing.id, {
      type: 'review.start', draft: { scope: { type: 'uncommittedChanges' } }
    })
    firstTransport.emit('notification', 'turn/diff/updated', {
      threadId: 'thread-existing',
      turnId: 'review-provider-failed',
      diff: reviewDiff('review.ts', 'before', 'after')
    })
    firstTransport.emit('notification', 'turn/completed', {
      threadId: 'thread-existing',
      turn: {
        id: 'review-provider-failed',
        status: 'failed',
        error: { message: 'provider review crashed asynchronously' }
      }
    })
    await waitForReviewState(() => current.status === 'error', 'failed Review completion')
    assert.equal(
      (await orchestrator.getEvents(existing.id)).some(({ type, state, payload }) =>
        type === 'turn_completed' && state === 'failed' && payload?.turnId === 'review-provider-failed'
      ),
      true
    )
    assert.equal(
      (await orchestrator.getTurnArtifactSummary(existing.id, 'review-provider-failed'))?.state,
      'ready',
      'failed provider completion must still release and finalize its artifact capture'
    )
    assert.equal((orchestrator as any).turnCapture.has(existing.id), false)

    // The next scenario starts from an idle session, not the terminal error above.
    current.status = 'idle'
    const pending = deferred<void>()
    firstTransport.reviewTurnId = 'review-reserved'
    firstTransport.reviewStartWait = pending.promise
    const reviewRequestsBeforeReservation = firstTransport.requests.filter(
      ({ method }) => method === 'review/start'
    ).length
    const reserved = orchestrator.runNativeAction(existing.id, {
      type: 'review.start', draft: { scope: { type: 'uncommittedChanges' } }
    })
    await waitForReviewState(
      () => firstTransport.requests.filter(({ method }) => method === 'review/start').length
        > reviewRequestsBeforeReservation,
      'reserved review/start request'
    )
    assert.equal(current.status, 'running', 'structured Review must use the tracked native action state')
    await assert.rejects(
      orchestrator.runNativeAction(existing.id, { type: 'goal.clear' }),
      /native_action_in_progress/
    )
    await assert.rejects(orchestrator.sendMessage(existing.id, 'must not overtake Review'), /native_action_in_progress/)
    await assert.rejects(orchestrator.forceSend(existing.id, 'must not force over Review'), /native_action_in_progress/)
    assert.match(
      (await orchestrator.previewSessionRewind(existing.id, 'prior-turn')).reason || '',
      /原生操作正在进行/
    )
    const configBeforeReservedReview = { ...current.config }
    await assert.rejects(orchestrator.updateSessionConfig(existing.id, { model: 'must-not-update-during-review' }), /原生操作正在进行/)
    assert.deepEqual(current.config, configBeforeReservedReview)
    pending.resolve()
    await reserved
    firstTransport.reviewStartWait = undefined
    firstTransport.emit('notification', 'turn/completed', {
      threadId: 'thread-existing', turn: { id: 'review-reserved', status: 'completed' }
    })
    await waitForReviewState(() => current.status === 'idle', 'reserved Review completion')

    for (const [label, arrange, restore, expected] of [
      ['archived', () => { current.archived = true }, () => { delete current.archived }, /已归档/],
      ['readOnly', () => { current.readOnly = true }, () => { delete current.readOnly }, /只读会话/],
      ['rewind', () => { (orchestrator as any).rewinding.add(existing.id) }, () => { (orchestrator as any).rewinding.delete(existing.id) }, /回退正在进行/],
      ['pending send', () => { (orchestrator as any).pendingSends.set(existing.id, 1) }, () => { (orchestrator as any).pendingSends.delete(existing.id) }, /消息正在发送/],
      ['busy', () => { current.status = 'running' }, () => { current.status = 'idle' }, /任务或排队消息/],
      ['durable queue', () => { (orchestrator as any).queues.set(existing.id, [{ id: 'queued' }]) }, () => { (orchestrator as any).queues.set(existing.id, []) }, /任务或排队消息/]
    ] as Array<[string, () => void, () => void, RegExp]>) {
      arrange()
      try {
        await assert.rejects(
          orchestrator.runNativeAction(existing.id, {
            type: 'review.start', draft: { scope: { type: 'uncommittedChanges' } }
          }),
          expected,
          `structured Review must share the ${label} writable-idle gate`
        )
      } finally {
        restore()
      }
    }

    firstTransport.failReview = true
    const eventsBeforeFailure = (await orchestrator.getEvents(existing.id)).length
    await assert.rejects(
      orchestrator.runNativeAction(existing.id, {
        type: 'review.start', draft: { scope: { type: 'uncommittedChanges' } }
      }),
      /provider rejected review/
    )
    assert.equal(current.status, 'idle')
    assert.deepEqual(current.goal, initialGoal)
    assert.equal(orchestrator.getQueue(existing.id).length, 0)
    const failureEvents = (await orchestrator.getEvents(existing.id)).slice(eventsBeforeFailure)
    assert.equal(failureEvents.some(({ type }) => type === 'user_message'), false)
    assert.equal(failureEvents.some(({ type, state }) => type === 'turn_completed' && state === 'success'), false)
    assert.match(String(failureEvents.find(({ type }) => type === 'error')?.payload?.message), /review\/start 失败/)
    firstTransport.failReview = false

    const newTransport = new RecordingTransport()
    newTransport.startedThreadId = 'thread-new-review'
    newTransport.reviewThreadId = 'thread-new-review'
    newTransport.reviewTurnId = 'review-new'
    newTransport.threadModel = 'new-model'
    queuedTransports.push(newTransport)
    const created = await orchestrator.createNativeActionSession(
      { ...baseConfig, workdir },
      { type: 'review.start', draft: { scope: { type: 'custom' }, instructions: '新会话审查' } },
      { handoffId: 'handoff-review', handoffWaiting: true }
    )
    assert.equal(created.title, 'Review')
    assert.equal(created.status, 'running')
    assert.equal(created.nativeSessionId, 'thread-new-review')
    assert.equal(created.handoffId, 'handoff-review')
    assert.equal(created.handoffWaiting, true)
    assert.equal((await orchestrator.getEvents(created.id)).some(({ type }) => type === 'user_message'), false)
    assert.deepEqual(orchestrator.getQueue(created.id), [])
    newTransport.emit('notification', 'turn/completed', {
      threadId: 'thread-new-review', turn: { id: 'review-new', status: 'completed' }
    })
    await waitForReviewState(() => created.status === 'idle', 'new Review completion')

    const newReviewPending = deferred<void>()
    const pendingNewTransport = new RecordingTransport()
    pendingNewTransport.startedThreadId = 'thread-pending-new-review'
    pendingNewTransport.reviewThreadId = 'thread-pending-new-review'
    pendingNewTransport.reviewTurnId = 'review-pending-new'
    pendingNewTransport.reviewStartWait = newReviewPending.promise
    queuedTransports.push(pendingNewTransport)
    const creatingPendingReview = orchestrator.createNativeActionSession(
      { ...baseConfig, workdir },
      { type: 'review.start', draft: { scope: { type: 'uncommittedChanges' } } }
    )
    await waitForReviewState(
      () => pendingNewTransport.requests.at(-1)?.method === 'review/start',
      'new Review reservation'
    )
    const pendingNewSession = orchestrator.listSessions().find(
      ({ nativeSessionId }) => nativeSessionId === 'thread-pending-new-review'
    )!
    try {
      await assert.rejects(
        orchestrator.runNativeAction(pendingNewSession.id, { type: 'goal.clear' }),
        /native_action_in_progress/
      )
      await assert.rejects(
        orchestrator.sendMessage(pendingNewSession.id, 'must not queue before new Review starts'),
        /native_action_in_progress/
      )
      await assert.rejects(
        orchestrator.forceSend(pendingNewSession.id, 'must not steer before new Review starts'),
        /native_action_in_progress/
      )
      assert.match(
        (await orchestrator.previewSessionRewind(pendingNewSession.id, 'review-pending-new')).reason || '',
        /原生操作正在进行/
      )
      assert.equal(
        (await orchestrator.getEvents(pendingNewSession.id)).some(({ type }) => type === 'user_message'),
        false
      )
      assert.deepEqual(orchestrator.getQueue(pendingNewSession.id), [])
    } finally {
      newReviewPending.resolve()
      const pendingCreated = await creatingPendingReview
      pendingNewTransport.reviewStartWait = undefined
      pendingNewTransport.emit('notification', 'turn/completed', {
        threadId: 'thread-pending-new-review', turn: { id: 'review-pending-new', status: 'completed' }
      })
      await waitForReviewState(() => pendingCreated.status === 'idle', 'pending new Review completion')
    }

    const failedTransport = new RecordingTransport()
    failedTransport.startedThreadId = 'thread-failed-review'
    failedTransport.reviewThreadId = 'thread-failed-review'
    failedTransport.failReview = true
    queuedTransports.push(failedTransport)
    const idsBeforeFailure = orchestrator.listSessions().map(({ id }) => id).sort()
    await assert.rejects(
      orchestrator.createNativeActionSession(
        { ...baseConfig, workdir },
        { type: 'review.start', draft: { scope: { type: 'uncommittedChanges' } } }
      ),
      /provider rejected review/
    )
    assert.deepEqual(orchestrator.listSessions().map(({ id }) => id).sort(), idsBeforeFailure)
    const liveIds = new Set(orchestrator.listSessions().map(({ id }) => id))
    assert.equal(
      [...(orchestrator as any).streamers.keys()].every((id: string) => liveIds.has(id)),
      true,
      'failed newly-created Review must not leave an orphan runner'
    )
  } finally {
    AppServerRunner.prototype.startReview = originalStartReview
    orchestrator.disposeAll()
    await orchestrator.closeSessionLogs()
    await rm(root, { recursive: true, force: true })
  }
}

async function orchestratorStartingReviewCancellation(): Promise<void> {
  const root = join(tmpdir(), `uniagent-native-review-cancel-${process.pid}-${Date.now()}`)
  const workdir = join(root, 'work')
  const store = new SessionStore(join(root, 'sessions.json'))
  const existing = {
    ...storedSession(initialGoal),
    config: { ...baseConfig, workdir },
    nativeSessionId: 'thread-existing'
  }
  await mkdir(workdir, { recursive: true })
  store.saveOrThrow([existing])
  const orchestrator = new Orchestrator(
    (id) => id === testAgent.id ? testAgent : undefined,
    store,
    join(root, 'artifacts')
  )
  orchestrator.loadPersisted()
  const originalStartReview = AppServerRunner.prototype.startReview
  const blocker = deferred<void>()
  const transport = new RecordingTransport()
  transport.goal = initialGoal
  transport.reviewThreadId = 'thread-existing'
  transport.reviewStartWait = blocker.promise
  try {
    AppServerRunner.prototype.startReview = async function (draft: NativeReviewDraft): Promise<void> {
      if (!(this as any).transport) (this as any).transportFactory = () => transport
      return originalStartReview.call(this, draft)
    }
    const session = orchestrator.getSessionById(existing.id)!
    const action = orchestrator.runNativeAction(existing.id, {
      type: 'review.start', draft: { scope: { type: 'uncommittedChanges' } }
    })
    void action.catch(() => {})
    await waitForReviewState(
      () => transport.requests.at(-1)?.method === 'review/start',
      'orchestrator pending Review before interrupt'
    )
    assert.equal(session.status, 'running')
    orchestrator.interrupt(existing.id)
    assert.ok(['cancelling', 'idle'].includes(session.status), 'cancellation may settle synchronously')
    const settled = await settleReviewWithin(action)
    if (settled.status === 'timeout') {
      blocker.resolve()
      await action
      transport.emit('notification', 'turn/completed', {
        threadId: 'thread-existing',
        turn: { id: 'review-1', status: 'interrupted' }
      })
      await waitForReviewState(() => session.status === 'idle', 'structured Review cleanup after timeout')
    }
    assert.equal(settled.status, 'rejected', 'Session interrupt must reject pending structured Review RPC')
    await waitForReviewState(() => session.status === 'idle', 'cancelled Review session cleanup')
    assert.equal((orchestrator as any).nativeActionReservations.has(existing.id), false)
    assert.equal((orchestrator as any).turnCapture.has(existing.id), false)
  } finally {
    AppServerRunner.prototype.startReview = originalStartReview
    orchestrator.disposeAll()
    await rm(root, { recursive: true, force: true })
  }
}

function emitServerRequest(
  transport: RecordingTransport,
  id: number | string,
  method: 'item/tool/requestUserInput' | 'item/commandExecution/requestApproval',
  marker: string
): void {
  transport.emit('serverRequest', {
    jsonrpc: '2.0',
    id,
    method,
    params: { marker }
  })
}

function pendingRequestFor(events: UAEvent[], marker: string): UAEvent {
  const event = events.find(({ type, state, payload }) =>
    type === 'approval_request' &&
    state === 'pending' &&
    payload?.params?.marker === marker
  )
  assert.ok(event, `missing pending server request: ${marker}`)
  return event
}

function terminalRequestEvents(events: UAEvent[], requestId: string): UAEvent[] {
  return events.filter(({ type, state, payload }) =>
    type === 'approval_request' &&
    (state === 'cancelled' || state === 'failed') &&
    payload?.requestId === requestId
  )
}

async function normalServerRequestsStayOnTheirOwner(): Promise<void> {
  const transport = new RecordingTransport()
  transport.goal = initialGoal
  const runner = recordingRunnerSequence([transport])
  const events: UAEvent[] = []
  runner.on('event', (event) => events.push(event))
  try {
    await runner.ensureThreadReady()
    await runner.getGoal()
    await runner.setCollaborationMode('default')
    await runner.startTurn('normal server request ownership')
    emitServerRequest(transport, 11, 'item/tool/requestUserInput', 'normal-question')
    emitServerRequest(transport, 12, 'item/commandExecution/requestApproval', 'normal-approval')
    const question = pendingRequestFor(events, 'normal-question')
    const approval = pendingRequestFor(events, 'normal-approval')
    const questionAnswer = { answers: { choice: { answers: ['yes'] } } }
    const approvalAnswer = { decision: 'accept' }
    runner.respond(question.payload.requestId, questionAnswer)
    runner.respond(approval.payload.requestId, approvalAnswer)
    assert.deepEqual(transport.responses, [
      { id: 11, result: questionAnswer },
      { id: 12, result: approvalAnswer }
    ])
    assert.equal(
      events.filter(({ type, state, payload }) =>
        type === 'approval_request' &&
        state === 'success' &&
        (payload?.requestId === question.payload.requestId || payload?.requestId === approval.payload.requestId)
      ).length,
      2
    )
    emitServerRequest(transport, 13, 'item/commandExecution/requestApproval', 'provider-resolved')
    const providerResolved = pendingRequestFor(events, 'provider-resolved')
    transport.emit('notification', 'serverRequest/resolved', {
      threadId: 'thread-1',
      requestId: 13
    })
    assert.equal(terminalRequestEvents(events, providerResolved.payload.requestId).length, 1)
    runner.respond(providerResolved.payload.requestId, { decision: 'accept' })
    assert.equal(transport.responses.length, 2, 'provider-resolved request must reject late UI answers')
    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' }
    })
  } finally {
    runner.dispose()
  }
}

async function providerExitPlanModeUsesModeChangeResponse(adapter: 'codex' | 'traex'): Promise<void> {
  const { agent, config } = appServerAgent(`${adapter}-mode-change`, adapter)
  config.collaborationMode = 'default'
  const transport = new RecordingTransport()
  const runner = recordingRunnerSequence([transport], undefined, config, agent)
  const events: UAEvent[] = []
  const collaborationModes: string[] = []
  runner.on('event', (event) => events.push(event))
  runner.on('collaborationModeChanged', (mode) => collaborationModes.push(mode))
  try {
    await runner.startTurn('先制定计划')
    transport.emit('notification', 'mode/changeRequested', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestId: 'enter-mode-request-1',
      targetMode: 'plan',
      sourceToolCallId: 'enter-plan-tool-1',
      reason: 'EnterPlanMode'
    })
    assert.deepEqual(transport.requests.at(-1), {
      method: 'mode/change/respond',
      params: {
        threadId: 'thread-1',
        requestId: 'enter-mode-request-1',
        decision: 'approved'
      }
    })
    assert.equal(
      events.some(({ type, state, payload }) =>
        type === 'approval_request' && state === 'pending' && payload?.kind === 'planMode'
      ),
      false,
      'EnterPlanMode must not block on a redundant user approval'
    )
    transport.emit('notification', 'mode/changeResolved', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestId: 'enter-mode-request-1',
      targetMode: 'plan',
      decision: 'approved'
    })
    transport.emit('notification', 'mode/changeRequested', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestId: 'mode-request-1',
      targetMode: 'default',
      sourceToolCallId: 'exit-plan-tool-1',
      reason: 'ExitPlanMode'
    })

    const request = events.find(({ type, state, payload }) =>
      type === 'approval_request' &&
      state === 'pending' &&
      payload?.kind === 'planMode'
    )
    assert.ok(request, 'ExitPlanMode must surface a pending plan decision')

    runner.respond(request.payload.requestId, { decision: 'rejected' })
    await waitForReviewState(
      () => transport.requests.some(({ method, params }) =>
        method === 'mode/change/respond' && params.requestId === 'mode-request-1'
      ),
      'rejected ExitPlanMode response'
    )
    assert.deepEqual(collaborationModes, ['plan'], 'rejecting implementation must stay in Plan mode')

    transport.emit('notification', 'mode/changeRequested', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestId: 'mode-request-2',
      targetMode: 'default',
      sourceToolCallId: 'exit-plan-tool-2',
      reason: 'ExitPlanMode'
    })
    const approvedRequest = events.findLast(({ type, state, payload }) =>
      type === 'approval_request' &&
      state === 'pending' &&
      payload?.kind === 'planMode'
    )
    assert.ok(approvedRequest, 'a later ExitPlanMode must remain answerable')

    runner.respond(approvedRequest.payload.requestId, { decision: 'approved' })
    await waitForReviewState(
      () => collaborationModes.at(-1) === 'default',
      'approved ExitPlanMode to update local collaboration mode'
    )
    assert.deepEqual(
      collaborationModes,
      ['plan', 'default'],
      'starting implementation must exit Plan without waiting for mode/changeResolved'
    )
    assert.deepEqual(
      transport.requests.filter(({ method }) => method === 'mode/change/respond'),
      [{
        method: 'mode/change/respond',
        params: {
          threadId: 'thread-1',
          requestId: 'enter-mode-request-1',
          decision: 'approved'
        }
      }, {
        method: 'mode/change/respond',
        params: {
          threadId: 'thread-1',
          requestId: 'mode-request-1',
          decision: 'rejected'
        }
      }, {
        method: 'mode/change/respond',
        params: {
          threadId: 'thread-1',
          requestId: 'mode-request-2',
          decision: 'approved'
        }
      }]
    )
    assert.deepEqual(transport.responses, [])
    transport.emit('notification', 'mode/changeResolved', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestId: 'mode-request-2',
      targetMode: 'default',
      decision: 'approved'
    })
    assert.equal(collaborationModes.at(-1), 'default')
  } finally {
    runner.dispose()
  }
}

async function appServerExitPlanModeUsesModeChangeResponse(): Promise<void> {
  for (const adapter of ['codex', 'traex'] as const) {
    await providerExitPlanModeUsesModeChangeResponse(adapter)
  }
}

async function planBadgeExitDismissesPendingModeChange(): Promise<void> {
  for (const adapter of ['codex', 'traex'] as const) {
    const transport = new RecordingTransport()
    const { agent, config } = appServerAgent(`plan-badge-exit-${adapter}`, adapter)
    const root = join(tmpdir(), `uniagent-plan-badge-exit-${adapter}-${process.pid}-${Date.now()}`)
    const workdir = join(root, 'work')
    const session: Session = {
      ...storedSession(),
      id: `plan-badge-exit-${adapter}`,
      config: { ...config, workdir },
      nativeSessionId: 'thread-1'
    }
    await mkdir(workdir, { recursive: true })
    const store = new SessionStore(join(root, 'sessions.json'))
    store.saveOrThrow([session])
    const orchestrator = new Orchestrator(
      (id) => id === agent.id ? agent : undefined,
      store,
      join(root, 'artifacts')
    )
    orchestrator.loadPersisted()
    const owner = orchestrator.getSessionById(session.id)!
    const runner = (orchestrator as any).ensureMainStreamer(
      owner,
      agent,
      owner.config,
      false
    ) as AppServerRunner
    ;(runner as any).transportFactory = () => transport
    try {
      await runner.ensureThreadReady()
      ;(orchestrator as any).setStatus(owner, 'running')
      transport.emit('notification', 'mode/changeRequested', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        requestId: `exit-plan-${adapter}`,
        targetMode: 'default',
        sourceToolCallId: `exit-plan-tool-${adapter}`,
        reason: 'ExitPlanMode'
      })
      assert.equal(owner.status, 'awaiting-approval')
      const requestsBeforeExit = transport.requests.length

      await orchestrator.setCollaborationMode(owner.id, 'default')
      await waitForReviewState(
        () => owner.config.collaborationMode === 'default',
        `${adapter} Plan badge exit to synchronize Default mode`
      )

      assert.deepEqual(transport.requests.slice(requestsBeforeExit), [{
        method: 'mode/change/respond',
        params: {
          threadId: 'thread-1',
          requestId: `exit-plan-${adapter}`,
          decision: 'cancelled'
        }
      }, {
        method: 'thread/settings/update',
        params: {
          threadId: 'thread-1',
          collaborationMode: {
            mode: 'default',
            settings: {
              model: 'configured-model',
              reasoning_effort: null,
              developer_instructions: null
            }
          }
        }
      }],
        'closing the Plan badge must select Default without approving implementation'
      )
      assert.equal(owner.status, 'running')
    } finally {
      orchestrator.disposeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function staleServerRequestCannotReachReplacementGeneration(): Promise<void> {
  const blocker = deferred<void>()
  const oldTransport = new RecordingTransport()
  oldTransport.reviewStartWait = blocker.promise
  const replacement = new RecordingTransport()
  const runner = recordingRunnerSequence([oldTransport, replacement])
  const events: UAEvent[] = []
  runner.on('event', (event) => events.push(event))
  try {
    await runner.ensureThreadReady()
    const firstReview = runner.startReview({ scope: { type: 'uncommittedChanges' } })
    await waitForReviewState(
      () => oldTransport.requests.some(({ method }) => method === 'review/start'),
      'old Review request before server request cancellation'
    )
    emitServerRequest(oldTransport, 71, 'item/tool/requestUserInput', 'old-question')
    emitServerRequest(oldTransport, 72, 'item/commandExecution/requestApproval', 'old-approval')
    const oldQuestion = pendingRequestFor(events, 'old-question')
    const oldApproval = pendingRequestFor(events, 'old-approval')

    runner.interrupt()
    const cancelled = await settleReviewWithin(firstReview)
    assert.equal(cancelled.status, 'rejected')

    await runner.startReview({ scope: { type: 'uncommittedChanges' } })
    emitServerRequest(replacement, 71, 'item/tool/requestUserInput', 'new-question')
    emitServerRequest(replacement, 72, 'item/commandExecution/requestApproval', 'new-approval')
    const newQuestion = pendingRequestFor(events, 'new-question')
    const newApproval = pendingRequestFor(events, 'new-approval')

    runner.respond(oldQuestion.payload.requestId, { answers: { stale: { answers: ['old'] } } })
    runner.respond(oldApproval.payload.requestId, { decision: 'decline' })
    assert.deepEqual(
      replacement.responses,
      [],
      'late UI responses from a retired generation must not answer replacement requests'
    )
    assert.notEqual(oldQuestion.payload.requestId, newQuestion.payload.requestId)
    assert.notEqual(oldApproval.payload.requestId, newApproval.payload.requestId)
    assert.equal(terminalRequestEvents(events, oldQuestion.payload.requestId).length, 1)
    assert.equal(terminalRequestEvents(events, oldApproval.payload.requestId).length, 1)
    assert.equal(
      events.filter(({ type, state, payload }) =>
        type === 'approval_request' &&
        state === 'success' &&
        (payload?.requestId === newQuestion.payload.requestId || payload?.requestId === newApproval.payload.requestId)
      ).length,
      0,
      'stale UI responses must not mark replacement request cards successful'
    )

    const newQuestionAnswer = { answers: { choice: { answers: ['new'] } } }
    const newApprovalAnswer = { decision: 'accept' }
    runner.respond(newQuestion.payload.requestId, newQuestionAnswer)
    runner.respond(newApproval.payload.requestId, newApprovalAnswer)
    assert.deepEqual(replacement.responses, [
      { id: 71, result: newQuestionAnswer },
      { id: 72, result: newApprovalAnswer }
    ])
    assert.equal(
      events.filter(({ type, state, payload }) =>
        type === 'approval_request' &&
        state === 'success' &&
        (payload?.requestId === oldQuestion.payload.requestId || payload?.requestId === oldApproval.payload.requestId)
      ).length,
      0,
      'stale UI responses must not emit success for retired request cards'
    )
    replacement.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: replacement.reviewTurnId, status: 'completed' }
    })
  } finally {
    blocker.resolve()
    runner.dispose()
  }
}

async function retiredGenerationsClosePendingServerRequestsOnce(): Promise<void> {
  const disconnectTransport = new RecordingTransport()
  const disconnectRunner = recordingRunnerSequence([disconnectTransport])
  const disconnectEvents: UAEvent[] = []
  disconnectRunner.on('event', (event) => disconnectEvents.push(event))
  await disconnectRunner.ensureThreadReady()
  emitServerRequest(disconnectTransport, 81, 'item/tool/requestUserInput', 'disconnect-question')
  emitServerRequest(disconnectTransport, 82, 'item/commandExecution/requestApproval', 'disconnect-approval')
  const disconnectQuestion = pendingRequestFor(disconnectEvents, 'disconnect-question')
  const disconnectApproval = pendingRequestFor(disconnectEvents, 'disconnect-approval')
  disconnectTransport.emit('disconnect', 'connection lost')
  disconnectTransport.emit('disconnect', 'duplicate disconnect')
  disconnectRunner.respond(disconnectQuestion.payload.requestId, { answers: {} })
  disconnectRunner.respond(disconnectApproval.payload.requestId, { decision: 'accept' })
  assert.equal(terminalRequestEvents(disconnectEvents, disconnectQuestion.payload.requestId).length, 1)
  assert.equal(terminalRequestEvents(disconnectEvents, disconnectApproval.payload.requestId).length, 1)
  assert.deepEqual(disconnectTransport.responses, [])
  disconnectRunner.dispose()

  const invalidBlocker = deferred<void>()
  const invalidTransport = new RecordingTransport()
  invalidTransport.reviewStartWait = invalidBlocker.promise
  invalidTransport.reviewTurnId = undefined
  const invalidRunner = recordingRunnerSequence([invalidTransport])
  const invalidEvents: UAEvent[] = []
  invalidRunner.on('event', (event) => invalidEvents.push(event))
  try {
    await invalidRunner.ensureThreadReady()
    const invalidReview = invalidRunner.startReview({ scope: { type: 'uncommittedChanges' } })
    await waitForReviewState(
      () => invalidTransport.requests.some(({ method }) => method === 'review/start'),
      'invalid Review response pending request'
    )
    emitServerRequest(invalidTransport, 83, 'item/tool/requestUserInput', 'invalid-question')
    invalidBlocker.resolve()
    const invalid = await settleReviewWithin(invalidReview)
    assert.equal(invalid.status, 'rejected')
    const invalidQuestion = pendingRequestFor(invalidEvents, 'invalid-question')
    invalidRunner.respond(invalidQuestion.payload.requestId, { answers: {} })
    assert.equal(terminalRequestEvents(invalidEvents, invalidQuestion.payload.requestId).length, 1)
    assert.deepEqual(invalidTransport.responses, [])
  } finally {
    invalidRunner.dispose()
  }

  const disposeTransport = new RecordingTransport()
  const disposeRunner = recordingRunnerSequence([disposeTransport])
  const disposeEvents: UAEvent[] = []
  disposeRunner.on('event', (event) => disposeEvents.push(event))
  await disposeRunner.ensureThreadReady()
  emitServerRequest(disposeTransport, 84, 'item/commandExecution/requestApproval', 'dispose-approval')
  const disposeApproval = pendingRequestFor(disposeEvents, 'dispose-approval')
  disposeRunner.dispose()
  disposeRunner.dispose()
  disposeRunner.respond(disposeApproval.payload.requestId, { decision: 'accept' })
  assert.equal(terminalRequestEvents(disposeEvents, disposeApproval.payload.requestId).length, 1)
  assert.deepEqual(disposeTransport.responses, [])
}

async function orchestratorRequestFixture(
  name: string,
  transports: RecordingTransport[]
): Promise<{
  root: string
  orchestrator: Orchestrator
  session: Session
  runner: AppServerRunner
}> {
  const root = join(tmpdir(), `uniagent-request-owner-${name}-${process.pid}-${Date.now()}`)
  const workdir = join(root, 'work')
  const session: Session = {
    ...storedSession(initialGoal),
    id: `request-owner-${name}`,
    title: `request owner ${name}`,
    config: { ...baseConfig, workdir },
    nativeSessionId: 'thread-1'
  }
  await mkdir(workdir, { recursive: true })
  const store = new SessionStore(join(root, 'sessions.json'))
  store.saveOrThrow([session])
  const orchestrator = new Orchestrator(
    (id) => id === testAgent.id ? testAgent : undefined,
    store,
    join(root, 'artifacts')
  )
  orchestrator.loadPersisted()
  const owner = orchestrator.getSessionById(session.id)!
  const runner = (orchestrator as any).ensureMainStreamer(owner, testAgent, owner.config, false) as AppServerRunner
  let next = 0
  ;(runner as any).transportFactory = () => {
    const transport = transports[next++]
    if (!transport) throw new Error('orchestrator request transport sequence exhausted')
    transport.goal = initialGoal
    transport.startedThreadId = 'thread-1'
    transport.reviewThreadId = 'thread-1'
    return transport
  }
  return { root, orchestrator, session: owner, runner }
}

async function orchestratorStaleDisconnectResponseState(): Promise<void> {
  const oldTransport = new RecordingTransport()
  const replacement = new RecordingTransport()
  const fixture = await orchestratorRequestFixture('disconnect', [oldTransport, replacement])
  const { root, orchestrator, session, runner } = fixture
  try {
    await runner.ensureThreadReady()
    emitServerRequest(oldTransport, 91, 'item/tool/requestUserInput', 'orchestrator-old-disconnect')
    const oldRequest = pendingRequestFor(await orchestrator.getEvents(session.id), 'orchestrator-old-disconnect')
    assert.equal(session.status, 'awaiting-approval')

    oldTransport.emit('disconnect', 'old generation disconnected')
    await runner.ensureThreadReady()
    emitServerRequest(replacement, 91, 'item/tool/requestUserInput', 'orchestrator-new-disconnect')
    const newRequest = pendingRequestFor(await orchestrator.getEvents(session.id), 'orchestrator-new-disconnect')
    assert.notEqual(oldRequest.payload.requestId, newRequest.payload.requestId)

    const staleResult = orchestrator.respondToRequest(
      session.id,
      oldRequest.payload.requestId,
      { answers: { stale: { answers: ['old'] } } }
    ) as any
    assert.deepEqual({
      result: staleResult,
      status: session.status,
      responses: replacement.responses,
      replacementSuccesses: (await orchestrator.getEvents(session.id)).filter(({ type, state, payload }) =>
        type === 'approval_request' &&
        state === 'success' &&
        payload?.requestId === newRequest.payload.requestId
      ).length
    }, {
      result: { handled: false, hasPendingRequests: true },
      status: 'awaiting-approval',
      responses: [],
      replacementSuccesses: 0
    })

    const currentResult = orchestrator.respondToRequest(
      session.id,
      newRequest.payload.requestId,
      { answers: { choice: { answers: ['new'] } } }
    ) as any
    assert.deepEqual(currentResult, { handled: true, hasPendingRequests: false })
    assert.equal(session.status, 'running')
    assert.equal(replacement.responses.length, 1)

    const duplicate = orchestrator.respondToRequest(
      session.id,
      newRequest.payload.requestId,
      { answers: { choice: { answers: ['duplicate'] } } }
    ) as any
    assert.deepEqual(duplicate, { handled: false, hasPendingRequests: false })
    assert.equal(replacement.responses.length, 1)
    assert.equal(session.status, 'running')
  } finally {
    orchestrator.disposeAll()
    await rm(root, { recursive: true, force: true })
  }
}

async function orchestratorMultipleServerRequestsStayAwaiting(): Promise<void> {
  const transport = new RecordingTransport()
  const fixture = await orchestratorRequestFixture('multiple', [transport])
  const { root, orchestrator, session, runner } = fixture
  try {
    await runner.ensureThreadReady()
    emitServerRequest(transport, 92, 'item/tool/requestUserInput', 'orchestrator-multiple-question')
    emitServerRequest(transport, 93, 'item/commandExecution/requestApproval', 'orchestrator-multiple-approval')
    const events = await orchestrator.getEvents(session.id)
    const question = pendingRequestFor(events, 'orchestrator-multiple-question')
    const approval = pendingRequestFor(events, 'orchestrator-multiple-approval')
    assert.equal(session.status, 'awaiting-approval')

    const first = orchestrator.respondToRequest(
      session.id,
      question.payload.requestId,
      { answers: { choice: { answers: ['one'] } } }
    ) as any
    assert.deepEqual(first, { handled: true, hasPendingRequests: true })
    assert.equal(session.status, 'awaiting-approval')

    const duplicate = orchestrator.respondToRequest(
      session.id,
      question.payload.requestId,
      { answers: { choice: { answers: ['duplicate'] } } }
    ) as any
    assert.deepEqual(duplicate, { handled: false, hasPendingRequests: true })
    assert.equal(session.status, 'awaiting-approval')
    assert.equal(transport.responses.length, 1)

    const last = orchestrator.respondToRequest(
      session.id,
      approval.payload.requestId,
      { decision: 'accept' }
    ) as any
    assert.deepEqual(last, { handled: true, hasPendingRequests: false })
    assert.equal(session.status, 'running')
    assert.equal(transport.responses.length, 2)

    emitServerRequest(transport, 94, 'item/commandExecution/requestApproval', 'orchestrator-single-approval')
    const single = pendingRequestFor(await orchestrator.getEvents(session.id), 'orchestrator-single-approval')
    assert.equal(session.status, 'awaiting-approval')
    const singleResult = orchestrator.respondToRequest(
      session.id,
      single.payload.requestId,
      { decision: 'accept' }
    ) as any
    assert.deepEqual(singleResult, { handled: true, hasPendingRequests: false })
    assert.equal(session.status, 'running')
  } finally {
    orchestrator.disposeAll()
    await rm(root, { recursive: true, force: true })
  }
}

async function orchestratorStaleInterruptResponseState(): Promise<void> {
  const blocker = deferred<void>()
  const oldTransport = new RecordingTransport()
  oldTransport.reviewStartWait = blocker.promise
  const replacement = new RecordingTransport()
  replacement.reviewTurnId = 'review-after-request-interrupt'
  const fixture = await orchestratorRequestFixture('interrupt', [oldTransport, replacement])
  const { root, orchestrator, session } = fixture
  try {
    const firstReview = orchestrator.runNativeAction(session.id, {
      type: 'review.start',
      draft: { scope: { type: 'uncommittedChanges' } }
    })
    await waitForReviewState(
      () => oldTransport.requests.some(({ method }) => method === 'review/start'),
      'orchestrator Review before request interrupt'
    )
    emitServerRequest(oldTransport, 95, 'item/commandExecution/requestApproval', 'orchestrator-old-interrupt')
    const oldRequest = pendingRequestFor(await orchestrator.getEvents(session.id), 'orchestrator-old-interrupt')
    assert.equal(session.status, 'awaiting-approval')
    orchestrator.interrupt(session.id)
    const interrupted = await settleReviewWithin(firstReview)
    assert.equal(interrupted.status, 'rejected')
    await waitForReviewState(() => session.status === 'idle', 'interrupted request owner cleanup')

    await orchestrator.runNativeAction(session.id, {
      type: 'review.start',
      draft: { scope: { type: 'uncommittedChanges' } }
    })
    emitServerRequest(replacement, 95, 'item/commandExecution/requestApproval', 'orchestrator-new-interrupt')
    const newRequest = pendingRequestFor(await orchestrator.getEvents(session.id), 'orchestrator-new-interrupt')
    const staleResult = orchestrator.respondToRequest(
      session.id,
      oldRequest.payload.requestId,
      { decision: 'decline' }
    ) as any
    assert.deepEqual({
      result: staleResult,
      status: session.status,
      responses: replacement.responses
    }, {
      result: { handled: false, hasPendingRequests: true },
      status: 'awaiting-approval',
      responses: []
    })

    const currentResult = orchestrator.respondToRequest(
      session.id,
      newRequest.payload.requestId,
      { decision: 'accept' }
    ) as any
    assert.deepEqual(currentResult, { handled: true, hasPendingRequests: false })
    assert.equal(session.status, 'running')
    replacement.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: replacement.reviewTurnId, status: 'completed' }
    })
    await waitForReviewState(() => session.status === 'idle', 'replacement Review cleanup')
  } finally {
    blocker.resolve()
    orchestrator.disposeAll()
    await orchestrator.closeSessionLogs()
    await rm(root, { recursive: true, force: true })
  }
}

async function orchestratorRetainOwnerReentry(
  mode: 'session-and-streamer' | 'streamer-only' | 'delete-owner'
): Promise<void> {
  const transport = new RecordingTransport()
  const fixture = await orchestratorRequestFixture(`retain-${mode}`, [transport])
  const { root, orchestrator, session, runner } = fixture
  const replacementSession: Session = { ...session, status: 'awaiting-approval' }
  const replacementStreamer = {
    removeAllListeners: () => undefined,
    dispose: () => undefined,
    interrupt: () => undefined
  }
  const statusChanges: string[] = []
  const onStatus = ({ status }: { status: string }): void => { statusChanges.push(status) }
  let reentered = false
  const replaceOwner = (event: UAEvent): void => {
    if (
      reentered ||
      event.type !== 'approval_request' ||
      event.state !== 'success' ||
      !Object.prototype.hasOwnProperty.call(event.payload || {}, 'submittedAnswer')
    ) return
    reentered = true
    if (mode === 'session-and-streamer') {
      ;(orchestrator as any).sessions.set(session.id, replacementSession)
      ;(orchestrator as any).streamers.set(session.id, replacementStreamer)
    } else if (mode === 'streamer-only') {
      ;(orchestrator as any).streamers.set(session.id, replacementStreamer)
    } else {
      ;(orchestrator as any).sessions.delete(session.id)
      ;(orchestrator as any).streamers.delete(session.id)
    }
  }
  try {
    await runner.ensureThreadReady()
    emitServerRequest(transport, `retain-${mode}`, 'item/commandExecution/requestApproval', `retain-${mode}`)
    const request = pendingRequestFor(await orchestrator.getEvents(session.id), `retain-${mode}`)
    assert.equal(session.status, 'awaiting-approval')
    orchestrator.on('statusChange', onStatus)
    orchestrator.on('event', replaceOwner)

    const result = orchestrator.respondToRequest(
      session.id,
      request.payload.requestId,
      { decision: 'accept' }
    ) as any
    assert.deepEqual(result, { handled: true, hasPendingRequests: false })
    assert.equal(reentered, true)
    assert.equal(session.status, 'awaiting-approval', `${mode} old Session must stay awaiting`)
    if (mode === 'session-and-streamer') {
      assert.equal(replacementSession.status, 'awaiting-approval', 'replacement Session must stay awaiting')
    }
    assert.deepEqual(
      statusChanges.filter((status) => status === 'running'),
      [],
      `${mode} retain reentry must not emit a stale running transition`
    )
  } finally {
    orchestrator.off('event', replaceOwner)
    orchestrator.off('statusChange', onStatus)
    runner.dispose()
    orchestrator.disposeAll()
    await rm(root, { recursive: true, force: true })
  }
}

async function orchestratorRetainNewPendingReentry(): Promise<void> {
  const transport = new RecordingTransport()
  const fixture = await orchestratorRequestFixture('retain-new-pending', [transport])
  const { root, orchestrator, session, runner } = fixture
  const statusChanges: string[] = []
  const onStatus = ({ status }: { status: string }): void => { statusChanges.push(status) }
  let reentered = false
  const registerPending = (event: UAEvent): void => {
    if (
      reentered ||
      event.type !== 'approval_request' ||
      event.state !== 'success' ||
      !Object.prototype.hasOwnProperty.call(event.payload || {}, 'submittedAnswer')
    ) return
    reentered = true
    emitServerRequest(
      transport,
      'retain-new-question',
      'item/tool/requestUserInput',
      'retain-new-question'
    )
  }
  try {
    await runner.ensureThreadReady()
    emitServerRequest(
      transport,
      'retain-original-approval',
      'item/commandExecution/requestApproval',
      'retain-original-approval'
    )
    const original = pendingRequestFor(
      await orchestrator.getEvents(session.id),
      'retain-original-approval'
    )
    orchestrator.on('statusChange', onStatus)
    orchestrator.on('event', registerPending)

    const first = orchestrator.respondToRequest(
      session.id,
      original.payload.requestId,
      { decision: 'accept' }
    ) as any
    assert.deepEqual(first, { handled: true, hasPendingRequests: true })
    assert.equal(reentered, true)
    assert.equal(session.status, 'awaiting-approval')
    assert.deepEqual(statusChanges.filter((status) => status === 'running'), [])

    orchestrator.off('event', registerPending)
    const next = pendingRequestFor(await orchestrator.getEvents(session.id), 'retain-new-question')
    const last = orchestrator.respondToRequest(
      session.id,
      next.payload.requestId,
      { answers: { choice: { answers: ['done'] } } }
    ) as any
    assert.deepEqual(last, { handled: true, hasPendingRequests: false })
    assert.equal(session.status, 'running', 'the actual last pending response must still resume running')
  } finally {
    orchestrator.off('event', registerPending)
    orchestrator.off('statusChange', onStatus)
    orchestrator.disposeAll()
    await rm(root, { recursive: true, force: true })
  }
}

async function orchestratorRetainOwnerAba(
  mode: 'session' | 'streamer' | 'session-and-streamer'
): Promise<void> {
  const transport = new RecordingTransport()
  const fixture = await orchestratorRequestFixture(`retain-aba-${mode}`, [transport])
  const { root, orchestrator, session, runner } = fixture
  const statusChanges: string[] = []
  const onStatus = ({ status }: { status: string }): void => { statusChanges.push(status) }
  let reentered = false
  const reinstallSameOwner = (event: UAEvent): void => {
    if (
      reentered ||
      event.type !== 'approval_request' ||
      event.state !== 'success' ||
      !Object.prototype.hasOwnProperty.call(event.payload || {}, 'submittedAnswer')
    ) return
    reentered = true
    if (mode === 'session' || mode === 'session-and-streamer') {
      const removed = (orchestrator as any).removeSessionOwner(session.id)
      assert.equal(removed, session)
      ;(orchestrator as any).installSessionOwner(session)
    }
    if (mode === 'streamer' || mode === 'session-and-streamer') {
      ;(orchestrator as any).disposeMainStreamer(session.id)
      ;(orchestrator as any).streamers.set(session.id, runner)
    }
  }
  try {
    await runner.ensureThreadReady()
    emitServerRequest(
      transport,
      `retain-aba-${mode}`,
      'item/commandExecution/requestApproval',
      `retain-aba-${mode}`
    )
    const request = pendingRequestFor(
      await orchestrator.getEvents(session.id),
      `retain-aba-${mode}`
    )
    orchestrator.on('statusChange', onStatus)
    orchestrator.on('event', reinstallSameOwner)

    const result = orchestrator.respondToRequest(
      session.id,
      request.payload.requestId,
      { decision: 'accept' }
    ) as any
    assert.deepEqual(result, { handled: true, hasPendingRequests: false })
    assert.equal(reentered, true)
    assert.equal((orchestrator as any).sessions.get(session.id), session)
    assert.equal((orchestrator as any).streamers.get(session.id), runner)
    assert.equal(session.status, 'awaiting-approval', `${mode} ABA must not resume stale owner`)
    assert.deepEqual(
      statusChanges.filter((status) => status === 'running'),
      [],
      `${mode} ABA must not emit stale running statusChange`
    )
  } finally {
    orchestrator.off('event', reinstallSameOwner)
    orchestrator.off('statusChange', onStatus)
    runner.dispose()
    orchestrator.disposeAll()
    await rm(root, { recursive: true, force: true })
  }
}

async function orchestratorRawSuccessOwnerAba(
  mode: 'session' | 'streamer' | 'session-and-streamer'
): Promise<void> {
  const transport = new RecordingTransport()
  const fixture = await orchestratorRequestFixture(`raw-success-aba-${mode}`, [transport])
  const { root, orchestrator, session, runner } = fixture
  const statusChanges: string[] = []
  const onStatus = ({ status }: { status: string }): void => { statusChanges.push(status) }
  let reentered = false
  const reinstallSameOwner = (event: UAEvent): void => {
    if (
      reentered ||
      event.type !== 'approval_request' ||
      event.state !== 'success' ||
      Object.prototype.hasOwnProperty.call(event.payload || {}, 'submittedAnswer')
    ) return
    reentered = true
    if (mode === 'session' || mode === 'session-and-streamer') {
      const removed = (orchestrator as any).removeSessionOwner(session.id)
      assert.equal(removed, session)
      ;(orchestrator as any).installSessionOwner(session)
    }
    if (mode === 'streamer' || mode === 'session-and-streamer') {
      ;(orchestrator as any).disposeMainStreamer(session.id)
      ;(orchestrator as any).installMainStreamerOwner(session.id, runner)
    }
  }
  try {
    await runner.ensureThreadReady()
    emitServerRequest(
      transport,
      `raw-success-aba-${mode}`,
      'item/commandExecution/requestApproval',
      `raw-success-aba-${mode}`
    )
    const request = pendingRequestFor(
      await orchestrator.getEvents(session.id),
      `raw-success-aba-${mode}`
    )
    orchestrator.on('statusChange', onStatus)
    orchestrator.on('event', reinstallSameOwner)

    const result = orchestrator.respondToRequest(
      session.id,
      request.payload.requestId,
      { decision: 'accept' }
    ) as any
    assert.deepEqual(result, { handled: true, hasPendingRequests: false })
    assert.equal(reentered, true)
    assert.equal((orchestrator as any).sessions.get(session.id), session)
    assert.equal((orchestrator as any).streamers.get(session.id), runner)
    assert.equal(session.status, 'awaiting-approval', `${mode} raw-success ABA must stay awaiting`)
    assert.deepEqual(
      statusChanges.filter((status) => status === 'running'),
      [],
      `${mode} raw-success ABA must not emit a stale running statusChange`
    )
    const matching = (await orchestrator.getEvents(session.id)).filter(
      (event) => event.type === 'approval_request' && event.payload?.requestId === request.payload.requestId
    )
    assert.equal(
      matching.some((event) => Object.prototype.hasOwnProperty.call(event.payload || {}, 'submittedAnswer')),
      false,
      `${mode} raw-success ABA must not retain the stale answer`
    )
    assert.equal(
      matching.some((event) => event.state === 'pending'),
      true,
      `${mode} raw-success ABA must preserve the pending request card`
    )
  } finally {
    orchestrator.off('event', reinstallSameOwner)
    orchestrator.off('statusChange', onStatus)
    orchestrator.disposeAll()
    await rm(root, { recursive: true, force: true })
  }
}

async function task7ReviewCoverage(): Promise<void> {
  const failures: Error[] = []
  const cases: Array<[string, () => void | Promise<void>]> = [
    ['Review target mapping', nativeReviewTargetMapping],
    ['NativeThreadAction parser', nativeThreadActionDtoValidation],
    ['tracked review/start lifecycle', trackedReviewRpcLifecycle],
    ['review/start failure cleanup', reviewRpcFailureCleanup],
    ['buffered Review startup ordering', bufferedReviewStartupOrdering],
    ['Review request buffer boundary', reviewBufferStartsAtReviewRequestBoundary],
    ['interrupted connection generation isolation', interruptedConnectAttemptCannotPolluteReviewRetry],
    ['disposed connection generation isolation', disposedConnectAttemptCannotContinue],
    ['failed Review completion lifecycle', failedReviewCompletionLifecycle],
    ['starting Review local cancellation', startingReviewLocalCancellation],
    ['orchestrator Review lifecycle', orchestratorReviewLifecycle],
    ['orchestrator starting Review cancellation', orchestratorStartingReviewCancellation],
    ['normal server request ownership', normalServerRequestsStayOnTheirOwner],
    ['app-server ExitPlanMode response protocol', appServerExitPlanModeUsesModeChangeResponse],
    ['Plan badge dismisses a pending provider mode change', planBadgeExitDismissesPendingModeChange],
    ['stale server request generation isolation', staleServerRequestCannotReachReplacementGeneration],
    ['retired server request cleanup', retiredGenerationsClosePendingServerRequestsOnce],
    ['orchestrator stale disconnect response', orchestratorStaleDisconnectResponseState],
    ['orchestrator multiple server request state', orchestratorMultipleServerRequestsStayAwaiting],
    ['orchestrator stale interrupt response', orchestratorStaleInterruptResponseState],
    ['orchestrator retain replaces Session and streamer', () =>
      orchestratorRetainOwnerReentry('session-and-streamer')],
    ['orchestrator retain replaces streamer', () =>
      orchestratorRetainOwnerReentry('streamer-only')],
    ['orchestrator retain deletes owner', () =>
      orchestratorRetainOwnerReentry('delete-owner')],
    ['orchestrator retain registers new pending', orchestratorRetainNewPendingReentry],
    ['orchestrator retain Session ABA', () => orchestratorRetainOwnerAba('session')],
    ['orchestrator retain streamer ABA', () => orchestratorRetainOwnerAba('streamer')],
    ['orchestrator retain Session and streamer ABA', () =>
      orchestratorRetainOwnerAba('session-and-streamer')],
    ['orchestrator raw-success Session ABA', () => orchestratorRawSuccessOwnerAba('session')],
    ['orchestrator raw-success streamer ABA', () => orchestratorRawSuccessOwnerAba('streamer')],
    ['orchestrator raw-success Session and streamer ABA', () =>
      orchestratorRawSuccessOwnerAba('session-and-streamer')]
  ]
  for (const [name, run] of cases) {
    try {
      await run()
    } catch (error: any) {
      failures.push(new Error(`${name}: ${error?.stack || error}`))
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Task 7 Review coverage failed')
}

if (process.env.UA_TEST_CASE === 'queue-wait') {
  await queueWaitMetadataSurvivesStatusReplacement()
  await queueWaitCompletionRequiresCompute()
  await interruptedQueueWaitIgnoresLateNotifications()
  await reviewStartupPreservesQueueReceivedAt()
  await abortedReviewIgnoresScopedStaleQueueWait()
  console.log('native-goal-plan-review: queue-wait ok')
  process.exit(0)
}

if (process.env.UA_TEST_CASE === 'traex-mode-change') {
  await appServerExitPlanModeUsesModeChangeResponse()
  console.log('native-goal-plan-review: traex-mode-change ok')
  process.exit(0)
}

if (process.env.UA_TEST_CASE === 'plan-mode-toggle') {
  await planCollaborationRpcOrdering()
  await planBadgeExitDismissesPendingModeChange()
  console.log('native-goal-plan-review: plan-mode-toggle ok')
  process.exit(0)
}

await queueWaitMetadataSurvivesStatusReplacement()
await queueWaitCompletionRequiresCompute()
await interruptedQueueWaitIgnoresLateNotifications()
await reviewStartupPreservesQueueReceivedAt()
await abortedReviewIgnoresScopedStaleQueueWait()
await goalRpcAndNotifications()
await providerCompletionSettlesGoalTurnOnce()
await sessionStoreGoalRoundTrip()
await sessionPlanMigrationAndRoundTrip()
await planRequiresAppServerTransport()
await planCollaborationRpcOrdering()
await coldCollaborationFailureInvalidatesConnection()
await securityConfigChangesReconnectReadyThreads()
await nonStreamingPlanFinalGuardsAreSideEffectFree()
await forceSendPropagatesPlanRejection()
await preparedPlanRouteRevalidatesCurrentAgent()
await userMessageCommitIsAtomicBeforePublicFanout()
await turnInputSnapshotsIsolateProviderAndQueue()
await queueDispatchCommitPreservesReentrantChanges()
await orchestratorGoalLifecycle()
await orchestratorManualCompactGate()
await orchestratorPlanActivation()
await nativeActionReservation()
await goalWireSequenceOrdering()
nativeGoalDtoValidation()
await task7ReviewCoverage()
console.log('native-goal-plan-review: ok')
